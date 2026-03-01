import { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

// ─── helpers ────────────────────────────────────────────────────────────────

function parseNumber(v) {
  if (v == null || v === "" || v === "-") return 0;
  const s = String(v).replace(/,/g, "").trim();
  return isNaN(Number(s)) ? 0 : Number(s);
}

function fmt(n) {
  if (Math.abs(n) >= 1e7) return "₹" + (n / 1e7).toFixed(2) + " Cr";
  if (Math.abs(n) >= 1e5) return "₹" + (n / 1e5).toFixed(2) + " L";
  return "₹" + n.toLocaleString("en-IN");
}

function fmtQty(n) {
  return n.toLocaleString("en-IN");
}

// Detect column indices from header row
function detectColumns(headers) {
  const h = headers.map((x) => String(x || "").toLowerCase().trim());
  const find = (...keys) => {
    for (const k of keys) {
      const i = h.findIndex((c) => c.includes(k));
      if (i !== -1) return i;
    }
    return -1;
  };
  return {
    isin: find("isin"),
    name: find("name", "issuer", "security", "company", "instrument"),
    quantity: find("quantity", "qty", "shares", "units", "no. of shares", "no of shares"),
    value: find("market value", "value", "mkt val", "amount", "corpus"),
    pct: find("% to", "% of", "percentage", "% nav", "% aum", "pct"),
  };
}

function parseSheet(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (!raw.length) return [];

  // Find header row (first row that has something resembling ISIN)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(20, raw.length); i++) {
    const row = raw[i].map((c) => String(c || "").toLowerCase());
    if (row.some((c) => c.includes("isin"))) {
      headerIdx = i;
      break;
    }
  }

  const headers = raw[headerIdx];
  const cols = detectColumns(headers);
  if (cols.isin === -1) return [];

  const rows = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    const isin = String(row[cols.isin] || "").trim();
    if (!isin || isin.length < 10 || !isin.match(/^[A-Z]{2}[A-Z0-9]{10}$/i)) continue;
    rows.push({
      isin: isin.toUpperCase(),
      name: cols.name !== -1 ? String(row[cols.name] || "").trim() : "Unknown",
      quantity: cols.quantity !== -1 ? parseNumber(row[cols.quantity]) : 0,
      value: cols.value !== -1 ? parseNumber(row[cols.value]) : 0,
      pct: cols.pct !== -1 ? parseNumber(row[cols.pct]) : 0,
    });
  }
  return rows;
}

function parseFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        // Try each sheet, combine all equities
        let all = [];
        for (const sn of wb.SheetNames) {
          const parsed = parseSheet(wb, sn);
          all = all.concat(parsed);
        }
        // De-dupe by ISIN (keep first occurrence)
        const seen = new Set();
        all = all.filter((r) => {
          if (seen.has(r.isin)) return false;
          seen.add(r.isin);
          return true;
        });
        resolve({ name: file.name, data: all });
      } catch {
        resolve({ name: file.name, data: [] });
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function compareMonths(months) {
  if (months.length < 2) return [];
  // Sort months by name (assume names have month info)
  const last = months[months.length - 1];
  const results = [];

  // Build ISIN map for each month
  const maps = months.map((m) => {
    const map = {};
    m.data.forEach((r) => (map[r.isin] = r));
    return map;
  });

  const allISINs = new Set(months.flatMap((m) => m.data.map((r) => r.isin)));

  for (const isin of allISINs) {
    const series = months.map((m, i) => maps[i][isin] || null);
    const lastEntry = series[series.length - 1];
    const prevEntry = series[series.length - 2];

    // Determine status
    let status = "unchanged";
    let qtyChange = 0;
    let valChange = 0;
    let pctChange = 0;

    if (!prevEntry && lastEntry) {
      status = "new";
      qtyChange = lastEntry.quantity;
      valChange = lastEntry.value;
      pctChange = lastEntry.pct;
    } else if (prevEntry && !lastEntry) {
      status = "exited";
      qtyChange = -prevEntry.quantity;
      valChange = -prevEntry.value;
      pctChange = -prevEntry.pct;
    } else if (prevEntry && lastEntry) {
      qtyChange = lastEntry.quantity - prevEntry.quantity;
      valChange = lastEntry.value - prevEntry.value;
      pctChange = lastEntry.pct - prevEntry.pct;
      if (qtyChange > 0) status = "increased";
      else if (qtyChange < 0) status = "decreased";
      else status = "unchanged";
    }

    if (status === "unchanged") continue;

    const name = (lastEntry || prevEntry).name;
    results.push({
      isin,
      name,
      status,
      qtyChange,
      valChange,
      pctChange,
      latestQty: lastEntry ? lastEntry.quantity : 0,
      latestVal: lastEntry ? lastEntry.value : 0,
      latestPct: lastEntry ? lastEntry.pct : 0,
      series,
    });
  }

  return results.sort((a, b) => Math.abs(b.valChange) - Math.abs(a.valChange));
}

// ─── sub-components ──────────────────────────────────────────────────────────

const statusConfig = {
  new:       { label: "New Buy",   bg: "#0d3320", border: "#22c55e", text: "#4ade80", arrow: "▲", dot: "#22c55e" },
  increased: { label: "Increased", bg: "#0a2a18", border: "#16a34a", text: "#86efac", arrow: "▲", dot: "#16a34a" },
  decreased: { label: "Trimmed",   bg: "#2d0d0d", border: "#ef4444", text: "#fca5a5", arrow: "▼", dot: "#ef4444" },
  exited:    { label: "Exited",    bg: "#3b0a0a", border: "#dc2626", text: "#f87171", arrow: "▼", dot: "#dc2626" },
};

function StockCard({ s, months }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = statusConfig[s.status];
  const isBuy = s.status === "new" || s.status === "increased";

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      style={{
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        borderRadius: 10,
        padding: "14px 16px",
        cursor: "pointer",
        transition: "transform 0.15s, box-shadow 0.15s",
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = `0 4px 24px ${cfg.border}44`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        {/* Left */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 18, color: cfg.text, fontWeight: 700 }}>{cfg.arrow}</span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "#f1f5f9",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {s.name}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>{s.isin}</div>
        </div>
        {/* Badge */}
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: cfg.text,
            background: cfg.border + "33",
            border: `1px solid ${cfg.border}`,
            borderRadius: 20,
            padding: "2px 10px",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {cfg.label}
        </span>
      </div>

      {/* Metrics row */}
      <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
        {[
          ["Qty Change", isBuy ? `+${fmtQty(Math.abs(s.qtyChange))}` : `-${fmtQty(Math.abs(s.qtyChange))}`, cfg.text],
          ["Value Change", (isBuy ? "+" : "") + fmt(s.valChange), cfg.text],
          ["% AUM Chg", (s.pctChange >= 0 ? "+" : "") + s.pctChange.toFixed(3) + "%", cfg.text],
          ...(s.status !== "exited" ? [["Current Holding", s.latestPct.toFixed(3) + "% of AUM", "#94a3b8"]] : []),
        ].map(([label, val, color]) => (
          <div key={label}>
            <div style={{ fontSize: 10, color: "#475569", marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Trend bar */}
      {expanded && (
        <div style={{ marginTop: 14, borderTop: "1px solid #1e293b", paddingTop: 12 }}>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>Monthly Quantity Trend</div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", height: 48 }}>
            {months.map((m, i) => {
              const entry = s.series[i];
              const maxQty = Math.max(...s.series.filter(Boolean).map((x) => x.quantity), 1);
              const h = entry ? Math.max(4, (entry.quantity / maxQty) * 44) : 4;
              return (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <div
                    style={{
                      width: "100%",
                      height: h,
                      background: entry ? cfg.border : "#1e293b",
                      borderRadius: 3,
                      transition: "height 0.3s",
                    }}
                    title={entry ? fmtQty(entry.quantity) : "Not held"}
                  />
                  <div style={{ fontSize: 9, color: "#475569", textAlign: "center", lineHeight: 1 }}>
                    {m.name.replace(/\.(xlsx?|csv)$/i, "").slice(-6)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── main app ────────────────────────────────────────────────────────────────

export default function App() {
  const [months, setMonths] = useState([]);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();

  const handleFiles = useCallback(async (files) => {
    setLoading(true);
    const parsed = await Promise.all(Array.from(files).map(parseFile));
    const valid = parsed.filter((p) => p.data.length > 0);

    if (valid.length === 0) {
      alert("No valid ISIN data found. Please upload AMC portfolio Excel/CSV files with an ISIN column.");
      setLoading(false);
      return;
    }

    // Sort by filename (assumes month info in filename)
    valid.sort((a, b) => a.name.localeCompare(b.name));
    setMonths(valid);
    setResults(compareMonths(valid));
    setLoading(false);
    setFilter("all");
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const filtered = results
    ? results.filter((s) => {
        const matchFilter =
          filter === "all" ||
          (filter === "buy" && (s.status === "new" || s.status === "increased")) ||
          (filter === "sell" && (s.status === "exited" || s.status === "decreased"));
        const matchSearch =
          !search ||
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          s.isin.toLowerCase().includes(search.toLowerCase());
        return matchFilter && matchSearch;
      })
    : [];

  const counts = results
    ? {
        new: results.filter((s) => s.status === "new").length,
        increased: results.filter((s) => s.status === "increased").length,
        decreased: results.filter((s) => s.status === "decreased").length,
        exited: results.filter((s) => s.status === "exited").length,
      }
    : {};

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#020917",
        color: "#e2e8f0",
        fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
        padding: "0 0 60px 0",
      }}
    >
      {/* Header */}
      <div
        style={{
          background: "linear-gradient(135deg, #0f172a 0%, #0c1a35 100%)",
          borderBottom: "1px solid #1e3a5f",
          padding: "24px 32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 36,
                height: 36,
                background: "linear-gradient(135deg, #3b82f6, #06b6d4)",
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 18,
              }}
            >
              📊
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5 }}>
                MF Portfolio Tracker
              </div>
              <div style={{ fontSize: 12, color: "#64748b" }}>
                AMC Monthly Holdings · Buy/Sell Signal Detector
              </div>
            </div>
          </div>
        </div>
        {months.length > 0 && (
          <button
            onClick={() => { setMonths([]); setResults(null); }}
            style={{
              background: "#1e293b",
              border: "1px solid #334155",
              color: "#94a3b8",
              borderRadius: 8,
              padding: "8px 16px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            ↺ Reset
          </button>
        )}
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 24px" }}>
        {/* Upload Zone */}
        {months.length === 0 && (
          <div style={{ padding: "40px 0" }}>
            <div
              onDrop={onDrop}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => fileRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? "#3b82f6" : "#1e3a5f"}`,
                borderRadius: 16,
                padding: "60px 40px",
                textAlign: "center",
                cursor: "pointer",
                background: dragOver ? "#0f1f3d" : "#0a1628",
                transition: "all 0.2s",
              }}
            >
              <div style={{ fontSize: 48, marginBottom: 16 }}>📁</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
                Drop AMC Portfolio Reports Here
              </div>
              <div style={{ fontSize: 14, color: "#64748b", marginBottom: 24, lineHeight: 1.7 }}>
                Upload <strong style={{ color: "#94a3b8" }}>2 to 6 monthly Excel / CSV files</strong> from any AMC<br />
                (e.g. <em>HDFC_Jul2024.xlsx, HDFC_Aug2024.xlsx, HDFC_Sep2024.xlsx</em>)
              </div>
              <button
                style={{
                  background: "linear-gradient(135deg, #3b82f6, #06b6d4)",
                  border: "none",
                  color: "#fff",
                  borderRadius: 10,
                  padding: "12px 28px",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Browse Files
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".xlsx,.xls,.csv"
                style={{ display: "none" }}
                onChange={(e) => handleFiles(e.target.files)}
              />
            </div>

            {/* Instructions */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 16,
                marginTop: 24,
              }}
            >
              {[
                ["🔢", "ISIN Detection", "Automatically finds ISIN columns in your report — no config needed"],
                ["📅", "Multi-Month Compare", "Upload 2–6 months and see exactly what changed each month"],
                ["🟢🔴", "Buy / Sell Signals", "New buys in green ▲, exits in red ▼, with quantity & value changes"],
                ["📊", "AUM %", "See each holding as a % of total AUM and how it shifted"],
              ].map(([icon, title, desc]) => (
                <div
                  key={title}
                  style={{
                    background: "#0a1628",
                    border: "1px solid #1e3a5f",
                    borderRadius: 12,
                    padding: "16px 18px",
                  }}
                >
                  <div style={{ fontSize: 22, marginBottom: 8 }}>{icon}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{title}</div>
                  <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>{desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: "center", padding: "80px 0" }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>⚙️</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Parsing Portfolio Reports…</div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 8 }}>Detecting ISIN columns and comparing months</div>
          </div>
        )}

        {/* Results */}
        {results && !loading && (
          <div style={{ paddingTop: 32 }}>
            {/* Month pills */}
            <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "#64748b" }}>Comparing:</span>
              {months.map((m, i) => (
                <span
                  key={i}
                  style={{
                    background: "#0f1f3d",
                    border: "1px solid #1e3a5f",
                    borderRadius: 20,
                    padding: "4px 12px",
                    fontSize: 12,
                    color: "#93c5fd",
                  }}
                >
                  {m.name.replace(/\.(xlsx?|csv)$/i, "")} ({m.data.length} stocks)
                </span>
              ))}
            </div>

            {/* Summary cards */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 12,
                marginBottom: 28,
              }}
            >
              {[
                { label: "New Buys",   val: counts.new,       color: "#22c55e", bg: "#0d3320" },
                { label: "Increased",  val: counts.increased, color: "#86efac", bg: "#0a2a18" },
                { label: "Trimmed",    val: counts.decreased, color: "#fca5a5", bg: "#2d0d0d" },
                { label: "Exited",     val: counts.exited,    color: "#f87171", bg: "#3b0a0a" },
              ].map((c) => (
                <div
                  key={c.label}
                  style={{
                    background: c.bg,
                    border: `1px solid ${c.color}44`,
                    borderRadius: 12,
                    padding: "16px 20px",
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 32, fontWeight: 800, color: c.color }}>{c.val}</div>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{c.label}</div>
                </div>
              ))}
            </div>

            {/* Filters + Search */}
            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 6 }}>
                {[
                  { id: "all", label: "All Changes" },
                  { id: "buy", label: "▲ Buys" },
                  { id: "sell", label: "▼ Sells" },
                ].map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    style={{
                      background: filter === f.id ? "#3b82f6" : "#0f1f3d",
                      border: `1px solid ${filter === f.id ? "#3b82f6" : "#1e3a5f"}`,
                      color: filter === f.id ? "#fff" : "#94a3b8",
                      borderRadius: 8,
                      padding: "7px 14px",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or ISIN…"
                style={{
                  flex: 1,
                  minWidth: 200,
                  background: "#0a1628",
                  border: "1px solid #1e3a5f",
                  color: "#e2e8f0",
                  borderRadius: 8,
                  padding: "7px 14px",
                  fontSize: 13,
                  outline: "none",
                }}
              />
            </div>

            {/* Count */}
            <div style={{ fontSize: 13, color: "#475569", marginBottom: 16 }}>
              Showing {filtered.length} of {results.length} changes · Click any card to expand trend
            </div>

            {/* Cards grid */}
            {filtered.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "#475569" }}>
                No changes match your filter.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                  gap: 12,
                }}
              >
                {filtered.map((s) => (
                  <StockCard key={s.isin} s={s} months={months} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
