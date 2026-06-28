// FinOps observability layer — read-only, non-enforcing.
//
// Provides attribution, realized-rate calculation, cache-discount savings,
// cheapest-equivalent-model advisor (report only), and simple burn
// forecasting over the existing append-only ledger. No policy is ever
// applied: every function returns data for a human (or another tool) to
// decide. Aligns with the user's stance: zoder is a sole-developer
// internal fork, so the surface is "observe, attribute, advise, report".

import type { Ledger } from "./ledger.js";
import type { LedgerEntry } from "./ledger.js";
import type { PricingCatalog, ModelPrice } from "./pricing.js";
import { dayKey, monthKey, weekKey } from "./time.js";

// ---------------------------------------------------------------------------
// LedgerEntry extensions (optional, non-breaking — populated by hosts that
// have FinOps tagging enabled; absent fields simply produce "untagged" rows).
// ---------------------------------------------------------------------------

/**
 * Optional FinOps tags attached to a ledger entry at ingestion time.
 * Hosts fill these when they know caller / task / tier / cache behavior.
 * All fields are optional so existing ledger rows (and existing hosts)
 * remain wire-compatible.
 */
export interface FinOpsTags {
  /** Logical caller identity (e.g. "zoder-cli", "zoder-loop-driver",
   *  "claude-code", "openclaw-agent-xyz"). */
  caller?: string;
  /** Task / project / feature tag (free-form short string). */
  task?: string;
  /** Tier label: "free" | "metered" | "premium" | unknown. */
  tier?: string;
  /** Fraction of input tokens served from provider cache, [0..1]. */
  cache_hit_ratio?: number;
}

/** Extended ledger row, used only by FinOps readers. */
export interface TaggedLedgerEntry extends LedgerEntry {
  caller?: string;
  task?: string;
  tier?: string;
  cache_hit_ratio?: number;
}

// ---------------------------------------------------------------------------
// Allocation — spend grouped by dimension
// ---------------------------------------------------------------------------

export interface SpendGroup {
  key: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  calls: number;
}

export function spendByDimension(
  ledger: Ledger,
  dim: keyof TaggedLedgerEntry,
  opts?: { since?: Date; until?: Date },
): SpendGroup[] {
  const acc = new Map<string, SpendGroup>();
  for (const row of ledger.entries() as TaggedLedgerEntry[]) {
    if (opts?.since && new Date(row.ts_utc) < opts.since) {
      continue;
    }
    if (opts?.until && new Date(row.ts_utc) > opts.until) {
      continue;
    }
    const raw = row[dim];
    const key = raw == null || raw === "" ? "__untagged__" : String(raw);
    const g =
      acc.get(key) ?? ({ key, cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 } as SpendGroup);
    g.cost_usd += row.cost_usd;
    g.tokens_in += row.tokens_in;
    g.tokens_out += row.tokens_out;
    g.calls += 1;
    acc.set(key, g);
  }
  return [...acc.values()].toSorted((a, b) => b.cost_usd - a.cost_usd);
}

// ---------------------------------------------------------------------------
// Realized rate — effective $/1M tok, computed from actual ledger entries
// rather than from catalog prices. Tells you what you *actually* paid per
// million tokens, which can differ from catalog (free models, negotiated
// rates, cache discounts, errored calls, etc.).
// ---------------------------------------------------------------------------

export interface ModelRealized {
  model: string;
  cost_usd: number;
  tokens: number;
  tokens_in: number;
  tokens_out: number;
  calls: number;
  /** Effective rate, $ per 1M tokens (blended input+output). NaN if no tokens. */
  realized_usd_per_mtok: number;
}

export function realizedRateByModel(
  ledger: Ledger,
  opts?: { since?: Date; until?: Date },
): ModelRealized[] {
  const acc = new Map<string, ModelRealized>();
  for (const row of ledger.entries()) {
    if (opts?.since && new Date(row.ts_utc) < opts.since) {
      continue;
    }
    if (opts?.until && new Date(row.ts_utc) > opts.until) {
      continue;
    }
    const tot = row.tokens_in + row.tokens_out;
    const r =
      acc.get(row.model) ??
      ({
        model: row.model,
        cost_usd: 0,
        tokens: 0,
        tokens_in: 0,
        tokens_out: 0,
        calls: 0,
        realized_usd_per_mtok: Number.NaN,
      } as ModelRealized);
    r.cost_usd += row.cost_usd;
    r.tokens_in += row.tokens_in;
    r.tokens_out += row.tokens_out;
    r.tokens += tot;
    r.calls += 1;
    acc.set(row.model, r);
  }
  for (const r of acc.values()) {
    r.realized_usd_per_mtok = r.tokens > 0 ? (r.cost_usd / r.tokens) * 1_000_000 : Number.NaN;
  }
  return [...acc.values()].toSorted((a, b) => b.cost_usd - a.cost_usd);
}

// ---------------------------------------------------------------------------
// Cache-discount savings — credit the user for tokens served from a cheaper
// cache-read rate vs. the full input rate. Report-only; the provider already
// applied the discount, this just makes it visible.
// ---------------------------------------------------------------------------

export interface CacheSavingsRow {
  model: string;
  calls: number;
  tokens_in: number;
  /** Sum of estimated cache-served tokens (cache_hit_ratio × tokens_in). */
  est_cached_tokens: number;
  /** Estimated $ saved vs. paying full input rate on those tokens. */
  est_savings_usd: number;
  /** Catalog input rate ($/Mtok). */
  input_usd_per_mtok: number;
  /** Catalog cache_read rate ($/Mtok). */
  cache_read_usd_per_mtok: number;
}

export function cacheSavingsByModel(
  ledger: Ledger,
  pricing: PricingCatalog,
  opts?: { since?: Date; until?: Date },
): CacheSavingsRow[] {
  const rows = new Map<string, CacheSavingsRow>();
  for (const e of ledger.entries() as TaggedLedgerEntry[]) {
    if (opts?.since && new Date(e.ts_utc) < opts.since) {
      continue;
    }
    if (opts?.until && new Date(e.ts_utc) > opts.until) {
      continue;
    }
    const hit = e.cache_hit_ratio ?? 0;
    if (hit <= 0) {
      continue;
    }
    const p = pricing.models.get(e.model);
    if (!p) {
      continue;
    }
    const cacheRate = p.cache_read_usd_per_mtok ?? 0;
    const inputRate = p.input_usd_per_mtok ?? p.usd_per_mtok ?? 0;
    if (inputRate <= 0 || cacheRate >= inputRate) {
      continue;
    }
    const cachedTokens = e.tokens_in * hit;
    const savings = ((inputRate - cacheRate) * cachedTokens) / 1_000_000;
    const r =
      rows.get(e.model) ??
      ({
        model: e.model,
        calls: 0,
        tokens_in: 0,
        est_cached_tokens: 0,
        est_savings_usd: 0,
        input_usd_per_mtok: inputRate,
        cache_read_usd_per_mtok: cacheRate,
      } as CacheSavingsRow);
    r.calls += 1;
    r.tokens_in += e.tokens_in;
    r.est_cached_tokens += cachedTokens;
    r.est_savings_usd += savings;
    rows.set(e.model, r);
  }
  return [...rows.values()].toSorted((a, b) => b.est_savings_usd - a.est_savings_usd);
}

// ---------------------------------------------------------------------------
// Cheapest-equivalent-model advisor — REPORT ONLY, never enforced.
// For each billed (non-free) model in the window, compute what the same
// token volume would have cost at the next-cheapest billed model. Useful
// for spotting "you're paying Sonnet rates for tasks Llama-3 handles".
// ---------------------------------------------------------------------------

export interface AdvisorRow {
  paid_model: string;
  paid_cost_usd: number;
  calls: number;
  tokens: number;
  cheapest_alt_model: string;
  cheapest_alt_usd_per_mtok: number;
  cheapest_alt_estimated_cost_usd: number;
  /** Absolute $ you'd save by switching wholesale. */
  potential_savings_usd: number;
  /** Same number expressed as a fraction of the paid cost (0..1). */
  potential_savings_ratio: number;
}

function effectiveRate(p: ModelPrice): number {
  // Prefer per-component: assume a 70/30 input/output mix as a heuristic
  // when only a blended rate is known. This is a report-only heuristic.
  if (p.input_usd_per_mtok || p.output_usd_per_mtok) {
    const i = p.input_usd_per_mtok ?? 0;
    const o = p.output_usd_per_mtok ?? 0;
    return 0.7 * i + 0.3 * o;
  }
  return p.usd_per_mtok ?? 0;
}

export function cheapestEquivalentAdvisor(
  ledger: Ledger,
  pricing: PricingCatalog,
  opts?: { since?: Date; until?: Date },
): AdvisorRow[] {
  // Build per-model paid spend over the window.
  const paid = new Map<string, { cost: number; calls: number; tokens: number }>();
  for (const row of ledger.entries()) {
    if (opts?.since && new Date(row.ts_utc) < opts.since) {
      continue;
    }
    if (opts?.until && new Date(row.ts_utc) > opts.until) {
      continue;
    }
    if (row.cost_usd <= 0) {
      continue;
    }
    const r = paid.get(row.model) ?? { cost: 0, calls: 0, tokens: 0 };
    r.cost += row.cost_usd;
    r.calls += 1;
    r.tokens += row.tokens_in + row.tokens_out;
    paid.set(row.model, r);
  }
  if (paid.size === 0) {
    return [];
  }

  // Build rate table for all priced (non-free) models in the catalog.
  const rates: { model: string; rate: number }[] = [];
  for (const [modelId, p] of pricing.models.entries()) {
    const r = effectiveRate(p);
    if (r > 0) {
      rates.push({ model: modelId, rate: r });
    }
  }
  rates.sort((a, b) => a.rate - b.rate);

  const out: AdvisorRow[] = [];
  for (const [model, r] of paid) {
    // Cheapest alt = lowest-rate model that's not the same one.
    const alt = rates.find((x) => x.model !== model) ?? null;
    if (!alt) {
      out.push({
        paid_model: model,
        paid_cost_usd: r.cost,
        calls: r.calls,
        tokens: r.tokens,
        cheapest_alt_model: "(none — paid model is cheapest in catalog)",
        cheapest_alt_usd_per_mtok: 0,
        cheapest_alt_estimated_cost_usd: 0,
        potential_savings_usd: 0,
        potential_savings_ratio: 0,
      });
      continue;
    }
    const altCost = (alt.rate * r.tokens) / 1_000_000;
    const savings = Math.max(0, r.cost - altCost);
    out.push({
      paid_model: model,
      paid_cost_usd: r.cost,
      calls: r.calls,
      tokens: r.tokens,
      cheapest_alt_model: alt.model,
      cheapest_alt_usd_per_mtok: alt.rate,
      cheapest_alt_estimated_cost_usd: altCost,
      potential_savings_usd: savings,
      potential_savings_ratio: r.cost > 0 ? savings / r.cost : 0,
    });
  }
  return out.toSorted((a, b) => b.potential_savings_usd - a.potential_savings_usd);
}

// ---------------------------------------------------------------------------
// Forecast — simple linear projection of $/day from the window's daily
// totals. Naive but useful for a one-person PoC: the whole point is to see
// a number, not to win a forecasting competition.
// ---------------------------------------------------------------------------

export interface BurnForecast {
  window_days: number;
  avg_daily_cost_usd: number;
  median_daily_cost_usd: number;
  trend_usd_per_day: number;
  forecast_7d_usd: number;
  forecast_30d_usd: number;
  sample_days: number;
}

function linearSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) {
    return 0;
  }
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function median(nums: number[]): number {
  if (nums.length === 0) {
    return 0;
  }
  const s = [...nums].toSorted((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

export function forecastBurn(
  ledger: Ledger,
  opts?: { windowDays?: number; until?: Date },
): BurnForecast {
  const windowDays = opts?.windowDays ?? 30;
  const until = opts?.until ?? new Date();
  const since = new Date(until.getTime() - windowDays * 86_400_000);
  const daily = new Map<string, number>();
  for (const row of ledger.entries()) {
    const d = new Date(row.ts_utc);
    if (d < since || d > until) {
      continue;
    }
    const k = dayKey(d);
    daily.set(k, (daily.get(k) ?? 0) + row.cost_usd);
  }
  const keys = [...daily.keys()].toSorted();
  const ys = keys.map((k) => daily.get(k) ?? 0);
  const xs = keys.map((_, i) => i);
  const slope = linearSlope(xs, ys);
  const meanY = ys.length === 0 ? 0 : ys.reduce((a, b) => a + b, 0) / ys.length;
  const lastX = xs.length === 0 ? 0 : xs[xs.length - 1];
  const project = (n: number) => Math.max(0, meanY + slope * (lastX + n));
  return {
    window_days: windowDays,
    avg_daily_cost_usd: meanY,
    median_daily_cost_usd: median(ys),
    trend_usd_per_day: slope,
    forecast_7d_usd: project(7),
    forecast_30d_usd: project(30),
    sample_days: ys.length,
  };
}

// ---------------------------------------------------------------------------
// Top-level rollup — the one-shot report a CLI can hand to a user.
// ---------------------------------------------------------------------------

export interface FinOpsReport {
  generated: string;
  since: string;
  until: string;
  total_cost_usd: number;
  total_tokens: number;
  total_calls: number;
  by_caller: SpendGroup[];
  by_task: SpendGroup[];
  by_model_realized: ModelRealized[];
  cache_savings: CacheSavingsRow[];
  advisor: AdvisorRow[];
  forecast: BurnForecast;
}

export function buildFinOpsReport(
  ledger: Ledger,
  pricing: PricingCatalog,
  opts: { since: Date; until: Date; windowDays?: number },
): FinOpsReport {
  const totals = { cost: 0, tokens: 0, calls: 0 };
  for (const r of ledger.entries()) {
    if (new Date(r.ts_utc) < opts.since || new Date(r.ts_utc) > opts.until) {
      continue;
    }
    totals.cost += r.cost_usd;
    totals.tokens += r.tokens_in + r.tokens_out;
    totals.calls += 1;
  }
  return {
    generated: new Date().toISOString(),
    since: opts.since.toISOString(),
    until: opts.until.toISOString(),
    total_cost_usd: totals.cost,
    total_tokens: totals.tokens,
    total_calls: totals.calls,
    by_caller: spendByDimension(ledger, "caller", opts),
    by_task: spendByDimension(ledger, "task", opts),
    by_model_realized: realizedRateByModel(ledger, opts),
    cache_savings: cacheSavingsByModel(ledger, pricing, opts),
    advisor: cheapestEquivalentAdvisor(ledger, pricing, opts),
    forecast: forecastBurn(ledger, {
      windowDays: opts.windowDays ?? 30,
      until: opts.until,
    }),
  };
}

// Re-export commonly-used helpers for consumers who want to slice the
// ledger along time periods (matches report.ts conventions).
export { dayKey, weekKey, monthKey };
