// Pure SVG chart renderer — zero dependencies.
// Supports: bar, line, pie, scatter, area.

export type ChartType = "bar" | "line" | "pie" | "scatter" | "area";

export type ChartDataSeries = { label: string; values: number[]; color?: string };

export type ChartOptions = {
  type: ChartType;
  title?: string;
  width: number;
  height: number;
  labels: string[];
  series: ChartDataSeries[];
  xLabel?: string;
  yLabel?: string;
  legend?: boolean;
};

type Pt = { x: number; y: number };

const COLORS = [
  "#4E79A7",
  "#F28E2B",
  "#E15759",
  "#76B7B2",
  "#59A14F",
  "#EDC948",
  "#B07AA1",
  "#FF9DA7",
  "#9C755F",
  "#BAB0AC",
];
const MARGIN = { top: 60, right: 40, bottom: 70, left: 70 };
const MAX_LABELS = 60;

function rgb(hex: string): string {
  return `${Number.parseInt(hex.slice(1, 3), 16)},${Number.parseInt(hex.slice(3, 5), 16)},${Number.parseInt(hex.slice(5, 7), 16)}`;
}

function el(tag: string, a: Record<string, string>, body?: string): string {
  const as = Object.entries(a)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return body ? `<${tag} ${as}>${body}</${tag}>` : `<${tag} ${as}/>`;
}

function tx(
  x: number,
  y: number,
  s: string,
  o: { a?: string; fs?: number; f?: string; b?: boolean; r?: number } = {},
): string {
  const attrs: Record<string, string> = {
    x: String(x),
    y: String(y),
    "font-family": "system-ui,sans-serif",
    "font-size": String(o.fs ?? 12),
    fill: o.f ?? "#333",
    "text-anchor": o.a ?? "start",
  };
  if (o.b) {
    attrs["font-weight"] = "bold";
  }
  if (o.r) {
    attrs.transform = `rotate(${o.r} ${x} ${y})`;
  }
  return el("text", attrs, esc(s));
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ln(x1: number, y1: number, x2: number, y2: number, c: string, d?: string): string {
  return el("line", {
    x1: String(x1),
    y1: String(y1),
    x2: String(x2),
    y2: String(y2),
    stroke: c,
    "stroke-width": "1",
    ...(d ? { "stroke-dasharray": d } : {}),
  });
}

function rc(x: number, y: number, w: number, h: number, f: string): string {
  return el("rect", {
    x: String(x),
    y: String(y),
    width: String(Math.max(0, w)),
    height: String(Math.max(0, h)),
    fill: f,
  });
}

function ci(cx: number, cy: number, r: number, f: string): string {
  return el("circle", { cx: String(cx), cy: String(cy), r: String(r), fill: f });
}

function pl(pts: Pt[], c: string, w: number, f?: string): string {
  return el("polyline", {
    points: pts.map((p) => `${p.x},${p.y}`).join(" "),
    stroke: c,
    "stroke-width": String(w),
    fill: f ?? "none",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
}

function pg(pts: Pt[], f: string): string {
  return el("polygon", {
    points: pts.map((p) => `${p.x},${p.y}`).join(" "),
    fill: f,
    stroke: "none",
  });
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (Math.abs(n) >= 1e3) {
    return `${(n / 1e3).toFixed(1)}K`;
  }
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function yRange(ss: ChartDataSeries[]): { yMin: number; yMax: number } {
  let lo = 0;
  let hi = 0;
  for (const s of ss) {
    for (const v of s.values) {
      if (v < lo) {
        lo = v;
      }
      if (v > hi) {
        hi = v;
      }
    }
  }
  if (lo === hi) {
    lo = 0;
    hi = hi || 10;
  }
  const pad = (hi - lo) * 0.1 || 1;
  return { yMin: lo - pad, yMax: hi + pad };
}

function axisLabels(o: ChartOptions, pW: number, pH: number): string {
  let out = "";
  if (o.xLabel) {
    out += tx(MARGIN.left + pW / 2, o.height - 10, o.xLabel, { a: "middle", fs: 12, f: "#444" });
  }
  if (o.yLabel) {
    out += tx(16, MARGIN.top + pH / 2, o.yLabel, { a: "middle", fs: 12, f: "#444", r: -90 });
  }
  return out;
}

function grid(
  pW: number,
  pH: number,
  ymin: number,
  ymax: number,
  lbs: string[],
  bw: number,
): string {
  let o = "";
  const r = ymax - ymin || 1;
  for (let i = 0; i <= 5; i++) {
    const v = ymin + (r * i) / 5;
    const py = MARGIN.top + pH - ((v - ymin) / r) * pH;
    o += ln(MARGIN.left, py, MARGIN.left + pW, py, "#e0e0e0", "4,4");
    o += tx(MARGIN.left - 8, py + 4, fmt(v), { a: "end", fs: 11, f: "#666" });
  }
  const s = pW / lbs.length;
  for (let i = 0; i < lbs.length; i++) {
    o += tx(MARGIN.left + s * i + bw / 2 + (s - bw) / 2, MARGIN.top + pH + 22, lbs[i], {
      a: "middle",
      fs: 10,
      f: "#666",
    });
  }
  return o;
}

function axis(pW: number, pH: number): string {
  return (
    ln(MARGIN.left, MARGIN.top, MARGIN.left, MARGIN.top + pH, "#333") +
    ln(MARGIN.left, MARGIN.top + pH, MARGIN.left + pW, MARGIN.top + pH, "#333")
  );
}

function drawBarChart(o: ChartOptions): string {
  const pW = o.width - MARGIN.left - MARGIN.right;
  const pH = o.height - MARGIN.top - MARGIN.bottom;
  const labels = o.labels.length > MAX_LABELS ? o.labels.slice(0, MAX_LABELS) : o.labels;
  const { yMin, yMax } = yRange(o.series);
  const nG = labels.length;
  const nS = o.series.length;
  const gW = pW / nG;
  const gap = gW * 0.15;
  const tBW = gW - gap * 2;
  const bW = tBW / nS;
  let out = grid(pW, pH, yMin, yMax, labels, tBW) + axis(pW, pH) + axisLabels(o, pW, pH);
  for (let g = 0; g < nG; g++) {
    const gx = MARGIN.left + gW * g + gap;
    for (let s = 0; s < nS; s++) {
      const v = o.series[s].values[g] ?? 0;
      const h = Math.abs(((v - yMin) / (yMax - yMin || 1)) * pH);
      const by = v >= yMin ? MARGIN.top + pH - h : MARGIN.top + pH;
      const co = o.series[s].color ?? COLORS[s % COLORS.length];
      if (h > 0) {
        out += rc(gx + bW * s, v >= 0 ? by : MARGIN.top, bW, Math.max(1, h), co);
        if (h > 20) {
          out += tx(gx + bW * s + bW / 2, by - 4, fmt(v), { a: "middle", fs: 9, f: "#333" });
        }
      }
    }
  }
  if (o.labels.length > MAX_LABELS) {
    out += tx(
      o.width / 2,
      o.height - 10,
      `(showing first ${MAX_LABELS} of ${o.labels.length} labels)`,
      { a: "middle", fs: 10, f: "#999" },
    );
  }
  return out;
}

function drawLineChart(o: ChartOptions, area: boolean): string {
  const pW = o.width - MARGIN.left - MARGIN.right;
  const pH = o.height - MARGIN.top - MARGIN.bottom;
  const { yMin, yMax } = yRange(o.series);
  const st = pW / Math.max(o.labels.length - 1, 1);
  let out =
    grid(pW, pH, yMin, yMax, o.labels, pW / o.labels.length) + axis(pW, pH) + axisLabels(o, pW, pH);
  for (let s = 0; s < o.series.length; s++) {
    const co = o.series[s].color ?? COLORS[s % COLORS.length];
    const pts: Pt[] = [];
    for (let i = 0; i < o.series[s].values.length; i++) {
      const x = MARGIN.left + st * i;
      const v = o.series[s].values[i] ?? 0;
      const y = MARGIN.top + pH - ((v - yMin) / (yMax - yMin || 1)) * pH;
      pts.push({ x, y });
      out += ci(x, y, 3, co);
    }
    if (area && pts.length >= 2) {
      const ap = [
        ...pts,
        { x: pts[pts.length - 1].x, y: MARGIN.top + pH },
        { x: pts[0].x, y: MARGIN.top + pH },
      ];
      out += pg(ap, `rgba(${rgb(co)}, 0.15)`);
    }
    if (pts.length >= 2) {
      out += pl(pts, co, 2.5);
    }
  }
  return out;
}

function drawPieChart(o: ChartOptions): string {
  const cx = o.width / 2;
  const cy = o.height / 2;
  const r = Math.min(o.width, o.height) / 2 - 60;
  const s = o.series[0];
  if (!s) {
    return "";
  }
  const vs = s.values;
  const t = vs.reduce((a, b) => a + b, 0);
  if (t === 0) {
    return tx(cx, cy, "No data", { a: "middle", fs: 14, f: "#999" });
  }
  let out = "";
  let a = -90;
  for (let i = 0; i < vs.length; i++) {
    const sa = (vs[i] / t) * 360;
    const ea = a + sa;
    const x1 = cx + r * Math.cos((a * Math.PI) / 180);
    const y1 = cy + r * Math.sin((a * Math.PI) / 180);
    const x2 = cx + r * Math.cos((ea * Math.PI) / 180);
    const y2 = cy + r * Math.sin((ea * Math.PI) / 180);
    const l = sa > 180 ? 1 : 0;
    const co = s.color ?? COLORS[i % COLORS.length];
    out += el("path", {
      d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${l} 1 ${x2} ${y2} Z`,
      fill: co,
      stroke: "#fff",
      "stroke-width": "2",
    });
    const m = (a + ea) / 2;
    const lx = cx + r * 0.7 * Math.cos((m * Math.PI) / 180);
    const ly = cy + r * 0.7 * Math.sin((m * Math.PI) / 180);
    const pct = `${((vs[i] / t) * 100).toFixed(1)}%`;
    out += tx(lx, ly - 6, o.labels[i] ?? "", { a: "middle", fs: 11, f: "#fff", b: true });
    out += tx(lx, ly + 8, pct, { a: "middle", fs: 10, f: "#fff" });
    a = ea;
  }
  return out;
}

function drawScatterChart(o: ChartOptions): string {
  const pW = o.width - MARGIN.left - MARGIN.right;
  const pH = o.height - MARGIN.top - MARGIN.bottom;
  const { yMin, yMax } = yRange(o.series);
  let out =
    grid(pW, pH, yMin, yMax, o.labels, pW / o.labels.length) + axis(pW, pH) + axisLabels(o, pW, pH);
  for (let s = 0; s < o.series.length; s++) {
    const co = o.series[s].color ?? COLORS[s % COLORS.length];
    for (let i = 0; i < o.series[s].values.length && i < o.labels.length; i++) {
      const x = MARGIN.left + (i / Math.max(o.labels.length - 1, 1)) * pW;
      const v = o.series[s].values[i] ?? 0;
      const y = MARGIN.top + pH - ((v - yMin) / (yMax - yMin || 1)) * pH;
      out += ci(x, y, 5, co);
    }
  }
  return out;
}

function drawLegend(o: ChartOptions): string {
  if (o.legend === false || o.series.length <= 1) {
    return "";
  }
  let out = "";
  let sx = (o.width - o.series.length * 160) / 2;
  for (let i = 0; i < o.series.length; i++) {
    const co = o.series[i].color ?? COLORS[i % COLORS.length];
    out += rc(sx, o.height - 16, 12, 12, co);
    out += tx(sx + 16, o.height - 4, o.series[i].label, { fs: 11, f: "#555" });
    sx += 160;
  }
  return out;
}

export function renderChartSVG(o: ChartOptions): string {
  let c = "";
  switch (o.type) {
    case "bar":
      c = drawBarChart(o);
      break;
    case "line":
      c = drawLineChart(o, false);
      break;
    case "area":
      c = drawLineChart(o, true);
      break;
    case "pie":
      c = drawPieChart(o);
      break;
    case "scatter":
      c = drawScatterChart(o);
      break;
  }
  const titleEl = o.title
    ? tx(o.width / 2, 30, o.title, { a: "middle", fs: 16, b: true, f: "#222" })
    : "";
  return el(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: String(o.width),
      height: String(o.height),
      viewBox: `0 0 ${o.width} ${o.height}`,
    },
    `<style>text{font-family:system-ui,-apple-system,sans-serif}</style>${titleEl}${c}${drawLegend(o)}`,
  );
}
