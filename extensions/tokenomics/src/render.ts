// Terminal rendering for tokenomics reports. Dependency-free ANSI so it drops
// into any host's CLI. Honors NO_COLOR and non-TTY (plain output).

import type { Report, RowByModel } from "./report.js";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;

const c = {
  dim: (s: string) => paint(s, "\x1b[2m"),
  bold: (s: string) => paint(s, "\x1b[1m"),
  green: (s: string) => paint(s, "\x1b[32m"),
  cyan: (s: string) => paint(s, "\x1b[36m"),
  yellow: (s: string) => paint(s, "\x1b[33m"),
};

function paint(s: string, code: string): string {
  return useColor ? `${code}${s}\x1b[0m` : s;
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tok(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

/** A unicode bar showing the free share of total tokens. */
export function shareBar(freeTokens: number, totalTokens: number, width = 24): string {
  if (totalTokens <= 0) {
    return `${"·".repeat(width)} 0% free`;
  }
  const frac = Math.max(0, Math.min(1, freeTokens / totalTokens));
  const filled = Math.round(frac * width);
  const bar = c.green("█".repeat(filled)) + c.dim("░".repeat(width - filled));
  return `${bar} ${(frac * 100).toFixed(0)}% free`;
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

/** A compact by-model table (top `limit` rows by cost). */
export function renderByModel(rows: RowByModel[], limit = 12): string {
  const top = rows.slice(0, limit);
  const nameW = Math.max(5, ...top.map((r) => r.model.length));
  const head =
    c.dim(padEnd("model", nameW)) +
    "  " +
    c.dim(padStart("calls", 7)) +
    "  " +
    c.dim(padStart("tokens", 9)) +
    "  " +
    c.dim(padStart("cost", 10)) +
    "  " +
    c.dim("tag");
  const lines = top.map((r) => {
    const tag = r.billed ? c.yellow("paid") : c.green("free");
    return (
      padEnd(r.model, nameW) +
      "  " +
      padStart(String(r.calls), 7) +
      "  " +
      padStart(tok(r.tokens), 9) +
      "  " +
      padStart(usd(r.cost_usd), 10) +
      "  " +
      tag
    );
  });
  return [head, ...lines].join("\n");
}

/** Full report render: headline, free-share bar, then by-model table. */
export function renderReport(rep: Report): string {
  const window = rep.period
    ? `${rep.period} (${rep.since} → ${rep.until}, ${rep.days}d)`
    : `${rep.since} → ${rep.until} (${rep.days}d)`;

  const headline = [
    c.bold("Tokenomics"),
    c.dim(window),
    "",
    `${c.dim("spent")}        ${c.bold(usd(rep.total_cost_usd))}  ${c.dim(`(${rep.total_calls} calls, ${tok(rep.total_tokens)} tok)`)}`,
    `${c.dim("avoided")}      ${c.green(usd(rep.avoided_usd))}  ${c.dim("free tokens valued at baseline")}`,
    `${c.dim("counterfactual")} ${c.cyan(usd(rep.counterfactual_usd))}  ${c.dim(`all tokens @ ${rep.baseline_model || "baseline"} (${usd(rep.baseline_usd_per_mtok)}/Mtok)`)}`,
    "",
    `${c.dim("free share")}   ${shareBar(rep.free_tokens, rep.total_tokens)}`,
  ].join("\n");

  return `${headline}\n\n${renderByModel(rep.by_model)}`;
}
