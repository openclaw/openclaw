import fs from "node:fs/promises";
import path from "node:path";
import type { MarketBar } from "./market-data.js";

export type ChartRenderResult = {
  text: string;
  mediaUrl?: string;
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatAsciiBar(value: number, min: number, max: number): string {
  if (max <= min) {
    return "##########";
  }
  const width = 10;
  const filled = Math.max(1, Math.round(((value - min) / (max - min)) * width));
  return "#".repeat(filled).padEnd(width, ".");
}

export function formatChartText(symbol: string, bars: MarketBar[]): string {
  if (bars.length === 0) {
    return `No chart bars available for ${symbol}.`;
  }
  const closes = bars.map((bar) => bar.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const first = closes[0]!;
  const last = closes[closes.length - 1]!;
  const change = last - first;
  const changePct = (change / first) * 100;
  const tail = bars
    .slice(-8)
    .map((bar) => `${bar.close.toFixed(2)} ${formatAsciiBar(bar.close, min, max)}`);
  return [
    `${symbol} data chart (latest ${bars.length} bars)`,
    `Range: ${min.toFixed(2)} - ${max.toFixed(2)}. Last: ${last.toFixed(2)} (${change >= 0 ? "+" : ""}${change.toFixed(2)}, ${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%).`,
    ...tail,
    "Source: Alpaca bars. Educational only.",
  ].join("\n");
}

function buildPolylinePoints(bars: MarketBar[]): string {
  const width = 680;
  const height = 240;
  const left = 28;
  const top = 78;
  const closes = bars.map((bar) => bar.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  return bars
    .map((bar, index) => {
      const x = left + (bars.length === 1 ? width : (index / (bars.length - 1)) * width);
      const y =
        max <= min ? top + height / 2 : top + height - ((bar.close - min) / (max - min)) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function renderChartSvg(symbol: string, bars: MarketBar[]): string {
  const closes = bars.map((bar) => bar.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const first = closes[0]!;
  const last = closes[closes.length - 1]!;
  const change = last - first;
  const stroke = change >= 0 ? "#138a48" : "#c2412d";
  const points = buildPolylinePoints(bars);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="760" height="380" viewBox="0 0 760 380" role="img" aria-label="${escapeXml(symbol)} price chart">
  <rect width="760" height="380" fill="#fbfbf8"/>
  <text x="28" y="42" fill="#151515" font-family="Arial, sans-serif" font-size="26" font-weight="700">${escapeXml(symbol)} intraday</text>
  <text x="28" y="66" fill="#555" font-family="Arial, sans-serif" font-size="14">Last ${last.toFixed(2)} | Range ${min.toFixed(2)} - ${max.toFixed(2)} | Data-driven chart</text>
  <line x1="28" y1="78" x2="708" y2="78" stroke="#ddd" stroke-width="1"/>
  <line x1="28" y1="198" x2="708" y2="198" stroke="#e8e8e4" stroke-width="1"/>
  <line x1="28" y1="318" x2="708" y2="318" stroke="#ddd" stroke-width="1"/>
  <polyline fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${points}"/>
  <circle cx="708" cy="${buildPolylinePoints(bars).split(" ").at(-1)?.split(",")[1] ?? "198"}" r="5" fill="${stroke}"/>
  <text x="28" y="354" fill="#666" font-family="Arial, sans-serif" font-size="12">Source: Alpaca bars. Educational only.</text>
</svg>
`;
}

export async function renderChartFile(params: {
  symbol: string;
  bars: MarketBar[];
  stateDir: string;
}): Promise<ChartRenderResult> {
  const text = formatChartText(params.symbol, params.bars);
  if (params.bars.length === 0) {
    return { text };
  }
  const chartDir = path.join(params.stateDir, "gesahni", "charts");
  await fs.mkdir(chartDir, { recursive: true, mode: 0o700 });
  const fileName = `${params.symbol.toLowerCase()}-${Date.now().toString(36)}.svg`;
  const filePath = path.join(chartDir, fileName);
  await fs.writeFile(filePath, renderChartSvg(params.symbol, params.bars), { mode: 0o600 });
  return { text, mediaUrl: filePath };
}
