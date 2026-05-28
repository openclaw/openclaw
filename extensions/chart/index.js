// src/chart-tool.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { imageResultFromFile } from "openclaw/plugin-sdk/channel-actions";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/param-readers";
// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

// src/render-svg.ts
var COLORS = [
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
var MARGIN = { top: 60, right: 40, bottom: 70, left: 70 };
var MAX_LABELS = 60;
function rgb(hex) {
  return `${Number.parseInt(hex.slice(1, 3), 16)},${Number.parseInt(hex.slice(3, 5), 16)},${Number.parseInt(hex.slice(5, 7), 16)}`;
}
function el(tag, a, body) {
  const as = Object.entries(a)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return body ? `<${tag} ${as}>${body}</${tag}>` : `<${tag} ${as}/>`;
}
function tx(x, y, s, o = {}) {
  const attrs = {
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
function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function ln(x1, y1, x2, y2, c, d) {
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
function rc(x, y, w, h, f) {
  return el("rect", {
    x: String(x),
    y: String(y),
    width: String(Math.max(0, w)),
    height: String(Math.max(0, h)),
    fill: f,
  });
}
function ci(cx, cy, r, f) {
  return el("circle", { cx: String(cx), cy: String(cy), r: String(r), fill: f });
}
function pl(pts, c, w, f) {
  return el("polyline", {
    points: pts.map((p) => `${p.x},${p.y}`).join(" "),
    stroke: c,
    "stroke-width": String(w),
    fill: f ?? "none",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
}
function pg(pts, f) {
  return el("polygon", {
    points: pts.map((p) => `${p.x},${p.y}`).join(" "),
    fill: f,
    stroke: "none",
  });
}
function fmt(n) {
  if (Math.abs(n) >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (Math.abs(n) >= 1e3) {
    return `${(n / 1e3).toFixed(1)}K`;
  }
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function yRange(ss) {
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
function axisLabels(o, pW, pH) {
  let out = "";
  if (o.xLabel) {
    out += tx(MARGIN.left + pW / 2, o.height - 10, o.xLabel, { a: "middle", fs: 12, f: "#444" });
  }
  if (o.yLabel) {
    out += tx(16, MARGIN.top + pH / 2, o.yLabel, { a: "middle", fs: 12, f: "#444", r: -90 });
  }
  return out;
}
function grid(pW, pH, ymin, ymax, lbs, bw) {
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
function axis(pW, pH) {
  return (
    ln(MARGIN.left, MARGIN.top, MARGIN.left, MARGIN.top + pH, "#333") +
    ln(MARGIN.left, MARGIN.top + pH, MARGIN.left + pW, MARGIN.top + pH, "#333")
  );
}
function drawBarChart(o) {
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
function drawLineChart(o, area) {
  const pW = o.width - MARGIN.left - MARGIN.right;
  const pH = o.height - MARGIN.top - MARGIN.bottom;
  const { yMin, yMax } = yRange(o.series);
  const st = pW / Math.max(o.labels.length - 1, 1);
  let out =
    grid(pW, pH, yMin, yMax, o.labels, pW / o.labels.length) + axis(pW, pH) + axisLabels(o, pW, pH);
  for (let s = 0; s < o.series.length; s++) {
    const co = o.series[s].color ?? COLORS[s % COLORS.length];
    const pts = [];
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
function drawPieChart(o) {
  const cx = o.width / 2;
  const cy = o.height / 2;
  const r = Math.min(o.width, o.height) / 2 - 60;
  const s = o.series[0];
  if (!s) {
    return "";
  }
  const vs = s.values;
  const t = vs.reduce((a2, b) => a2 + b, 0);
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
function drawScatterChart(o) {
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
function drawLegend(o) {
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
function renderChartSVG(o) {
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

// src/chart-tool.ts
var CHART_TYPES = ["bar", "line", "pie", "scatter", "area"];
var ChartToolSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      description: "Chart type: bar, line, pie, scatter, or area.",
      enum: CHART_TYPES,
    },
    title: { type: "string", description: "Optional chart title." },
    labels: {
      type: "array",
      items: { type: "string" },
      description: "Labels for the x-axis, or segment names for pie charts.",
    },
    series: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Series name shown in the legend." },
          values: {
            type: "array",
            items: { type: "number" },
            description: "Data values for this series. Must have the same length as labels.",
          },
          color: { type: "string", description: "Optional hex color (e.g. #4E79A7)." },
        },
        required: ["label", "values"],
        additionalProperties: false,
      },
      description: "One or more data series to plot.",
    },
    width: {
      type: "integer",
      description: "Image width in pixels (200\u20134000, default 800).",
      minimum: 200,
      maximum: 4e3,
    },
    height: {
      type: "integer",
      description: "Image height in pixels (200\u20134000, default 500).",
      minimum: 200,
      maximum: 4e3,
    },
    xLabel: { type: "string", description: "Optional label for the x-axis." },
    yLabel: { type: "string", description: "Optional label for the y-axis." },
    showLegend: {
      type: "boolean",
      description: "Whether to show the legend. Defaults to true for multi-series charts.",
    },
  },
  required: ["type", "labels", "series"],
  additionalProperties: false,
};
function parseSeries(raw, labelsLen) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('The "series" parameter must be a non-empty array.');
  }
  return raw.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new Error(`series[${idx}] must be an object with "label" and "values" fields.`);
    }
    const obj = item;
    const label =
      typeof obj.label === "string" && obj.label.trim() ? obj.label : `Series ${idx + 1}`;
    const values = Array.isArray(obj.values) ? obj.values.map(Number) : [];
    if (values.length !== labelsLen) {
      throw new Error(
        `series[${idx}] ("${label}"): values length (${values.length}) does not match labels length (${labelsLen}). Each series must have one value per label.`,
      );
    }
    const color = typeof obj.color === "string" ? obj.color : void 0;
    return { label, values, color };
  });
}
function createChartTool() {
  return {
    name: "chart",
    label: "Generate Chart",
    description:
      "Generate a chart (bar, line, pie, scatter, or area) from structured data as an SVG image. Use this to visualize data, create reports, or show trends. Each series must have the same number of values as the labels array.",
    parameters: ChartToolSchema,
    execute: async (...executeArgs) => {
      const [, args] = executeArgs;
      const a = args;
      const chartType = readStringParam(a, "type", { required: true });
      if (!CHART_TYPES.includes(chartType)) {
        throw new Error(
          `Unknown chart type "${chartType}". Valid types: ${CHART_TYPES.join(", ")}.`,
        );
      }
      const labels = readStringArrayParam(a, "labels", { required: true });
      if (labels.length === 0) {
        throw new Error('The "labels" array must not be empty.');
      }
      if (labels.length > 100) {
        throw new Error(`Too many labels (${labels.length}). Maximum is 100.`);
      }
      const series = parseSeries(a.series, labels.length);
      const title = readStringParam(a, "title");
      const w = readNumberParam(a, "width", { integer: true });
      const h = readNumberParam(a, "height", { integer: true });
      const width = Math.max(200, Math.min(4e3, typeof w === "number" ? w : 800));
      const height = Math.max(200, Math.min(4e3, typeof h === "number" ? h : 500));
      const showLegend = a.showLegend !== false;
      const svg = renderChartSVG({
        type: chartType,
        title,
        width,
        height,
        labels,
        series,
        xLabel: readStringParam(a, "xLabel"),
        yLabel: readStringParam(a, "yLabel"),
        legend: showLegend,
      });
      const dir = path.join(resolvePreferredOpenClawTmpDir(), "charts");
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `chart-${chartType}-${randomUUID().slice(0, 8)}.svg`);
      await fs.writeFile(filePath, svg, "utf-8");
      return imageResultFromFile({ label: `chart-${chartType}`, path: filePath });
    },
  };
}

// index.ts
var index_default = definePluginEntry({
  id: "chart-generator",
  name: "Chart Plugin",
  description: "Bundled chart generation plugin \u2014 bar, line, pie, scatter, and area charts",
  register(api) {
    api.registerTool(createChartTool());
  },
});
export { index_default as default };
