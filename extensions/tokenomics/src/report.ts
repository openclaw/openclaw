// Tokenomics report: local-first usage + chargeback rollups from the spend
// ledger, priced by the pricing catalog.
//
// Time-series buckets at a chosen granularity (hour/day/week/month) over an
// explicit window, plus a by-model breakdown and the avoided-spend headline
// (free tokens valued at the frontier baseline). Per-call cost comes from the
// ledger entry itself (the truth for what was paid); the pricing catalog drives
// only the counterfactual.

import type { Ledger } from "./ledger.js";
import type { PricingCatalog } from "./pricing.js";
import { dayKey, hourKey, monthKey, weekKey } from "./time.js";

export type Gran = "hour" | "day" | "week" | "month";

export function parseGran(s: string): Gran {
  switch (s.toLowerCase()) {
    case "hour":
    case "hourly":
      return "hour";
    case "week":
    case "weekly":
      return "week";
    case "month":
    case "monthly":
      return "month";
    default:
      return "day";
  }
}

const GRAN_KEYS: Record<Gran, (d: Date) => string> = {
  hour: hourKey,
  day: dayKey,
  week: weekKey,
  month: monthKey,
};

function granKey(gran: Gran, ts: Date): string {
  return GRAN_KEYS[gran](ts);
}

export interface Bucket {
  key: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  calls: number;
}

export interface RowByModel {
  model: string;
  cost_usd: number;
  tokens: number;
  tokens_in: number;
  tokens_out: number;
  calls: number;
  /**
   * True when the model actually incurred a chargeback (a paid cloud model).
   * Derived from recorded spend, never from a fuzzy catalog match, so free
   * (zero-cost) models are never mislabeled paid.
   */
  billed: boolean;
  /** Catalog input rate ($ / 1M tok), populated only for billed models. */
  input_usd_per_mtok: number;
  /** Catalog output rate ($ / 1M tok), populated only for billed models. */
  output_usd_per_mtok: number;
}

export interface Report {
  period: string;
  since: string;
  until: string;
  days: number;
  bucket_gran: Gran;
  buckets: Bucket[];
  by_model: RowByModel[];
  /** Externally-billed chargeback over the window (the cash number). */
  total_cost_usd: number;
  total_tokens: number;
  total_calls: number;
  /** Tokens served at $0 chargeback (free / zero-cost providers). */
  free_tokens: number;
  billed_tokens: number;
  /** Free tokens valued at the frontier baseline (avoided external spend). */
  avoided_usd: number;
  /**
   * ALL tokens valued at the frontier baseline: what the window WOULD have
   * cost on the baseline model.
   */
  counterfactual_usd: number;
  baseline_model: string;
  baseline_usd_per_mtok: number;
}

export interface BuildReportOptions {
  ledger: Ledger;
  pricing: PricingCatalog;
  since: Date;
  until: Date;
  gran?: Gran;
  /** Human label for the window, e.g. "this month", "Q2 2026", "YTD 2026". */
  period?: string;
}

/**
 * Build a report over an explicit `[since, until]` window from the local ledger,
 * bucketing the time series at `gran`. Cost is taken from each ledger entry; the
 * pricing catalog is used only for the avoided-spend / counterfactual baseline.
 */
export function buildReport(opts: BuildReportOptions): Report {
  const { ledger, pricing, since, until } = opts;
  const gran = opts.gran ?? "day";
  const entries = ledger.entriesIn(since, until);

  const buckets = new Map<string, Bucket>();
  const models = new Map<string, RowByModel>();

  const rep: Report = {
    period: opts.period ?? "",
    since: dayKey(since),
    until: dayKey(until),
    days: Math.max(1, Math.ceil((until.getTime() - since.getTime()) / 86_400_000)),
    bucket_gran: gran,
    buckets: [],
    by_model: [],
    total_cost_usd: 0,
    total_tokens: 0,
    total_calls: 0,
    free_tokens: 0,
    billed_tokens: 0,
    avoided_usd: 0,
    counterfactual_usd: 0,
    baseline_model: pricing.baselineModel,
    baseline_usd_per_mtok: pricing.baselineUsdPerMtok,
  };

  for (const e of entries) {
    const cost = e.cost_usd;
    const billed = e.cost_usd > 0;
    const tok = e.tokens_in + e.tokens_out;
    const ts = new Date(e.ts_utc);

    const key = granKey(gran, ts);
    const b = buckets.get(key) ?? {
      key,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      calls: 0,
    };
    b.cost_usd += cost;
    b.tokens_in += e.tokens_in;
    b.tokens_out += e.tokens_out;
    b.calls += 1;
    buckets.set(key, b);

    const m = models.get(e.model) ?? {
      model: e.model,
      cost_usd: 0,
      tokens: 0,
      tokens_in: 0,
      tokens_out: 0,
      calls: 0,
      billed: false,
      input_usd_per_mtok: 0,
      output_usd_per_mtok: 0,
    };
    m.cost_usd += cost;
    m.tokens += tok;
    m.tokens_in += e.tokens_in;
    m.tokens_out += e.tokens_out;
    m.calls += 1;
    m.billed ||= billed;
    models.set(e.model, m);

    rep.total_cost_usd += cost;
    rep.total_tokens += tok;
    rep.total_calls += 1;
    if (billed) {
      rep.billed_tokens += tok;
    } else {
      rep.free_tokens += tok;
    }
  }

  // Baseline for the avoided-spend / counterfactual headline. The authoritative
  // per-call cost already comes from the host (OpenClaw's own model.usage cost),
  // so by default the baseline is derived from observed spend — the highest
  // effective $/Mtok among paid models actually used in the window — rather than
  // from a separate price catalog. An optional pricing catalog may override it.
  let baselinePerMtok = pricing.baselineUsdPerMtok;
  let baselineModel = pricing.baselineModel;
  if (baselinePerMtok <= 0) {
    let bestRate = 0;
    let bestModel = "";
    for (const row of models.values()) {
      if (row.billed && row.tokens > 0) {
        const rate = (row.cost_usd / row.tokens) * 1_000_000;
        if (rate > bestRate) {
          bestRate = rate;
          bestModel = row.model;
        }
      }
    }
    baselinePerMtok = bestRate;
    baselineModel = bestModel;
  }
  rep.baseline_usd_per_mtok = baselinePerMtok;
  rep.baseline_model = baselineModel;
  rep.avoided_usd = (rep.free_tokens / 1_000_000) * baselinePerMtok;
  rep.counterfactual_usd = (rep.total_tokens / 1_000_000) * baselinePerMtok;
  rep.buckets = [...buckets.values()].toSorted((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  for (const row of models.values()) {
    if (row.billed) {
      const price = pricing.lookup(row.model);
      if (price) {
        row.input_usd_per_mtok = price.input_usd_per_mtok ?? 0;
        row.output_usd_per_mtok = price.output_usd_per_mtok ?? 0;
      }
    }
  }
  rep.by_model = [...models.values()].toSorted(
    (a, b) => b.cost_usd - a.cost_usd || b.tokens - a.tokens,
  );

  return rep;
}
