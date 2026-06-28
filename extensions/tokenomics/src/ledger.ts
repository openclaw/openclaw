// Local spend ledger. Append-only JSONL, one record per model call. SQLite is a
// drop-in later via the same shape.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { dayKey, monthKey, weekKey, yearKey } from "./time.js";

/** One persisted ledger record. */
export interface LedgerEntry {
  /** RFC3339 / ISO-8601 timestamp (UTC). */
  ts_utc: string;
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  /** Set when a post-call free-policy guard flagged this spend. */
  violation?: string;
  /** Host that emitted the event, for provenance/debugging. */
  host?: string;
}

export type Period = "day" | "week" | "month" | "year";

export function parsePeriod(s: string): Period | undefined {
  switch (s.toLowerCase()) {
    case "day":
    case "daily":
      return "day";
    case "week":
    case "weekly":
      return "week";
    case "month":
    case "monthly":
      return "month";
    case "year":
    case "yearly":
      return "year";
    default:
      return undefined;
  }
}

const PERIOD_KEYS: Record<Period, (d: Date) => string> = {
  day: dayKey,
  week: weekKey,
  month: monthKey,
  year: yearKey,
};

function periodBucket(period: Period, ts: Date): string {
  return PERIOD_KEYS[period](ts);
}

export interface Rollup {
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  calls: number;
}

function emptyRollup(): Rollup {
  return { cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 };
}

/** Optional hooks for ledger reads/writes. */
export interface LedgerOptions {
  /** Invoked once per read with the count of skipped malformed lines (> 0). */
  onMalformed?: (count: number) => void;
  /** Invoked when a write fails (disk full, permission, etc.). The event is
   *  dropped; the caller decides whether to retry. When omitted, write
   *  failures are silently swallowed so they never crash the process. */
  onError?: (err: unknown) => void;
}

export class Ledger {
  private readonly onMalformed?: (count: number) => void;
  private readonly onError?: (err: unknown) => void;
  private dirCreated = false;

  constructor(
    private readonly path: string,
    opts?: LedgerOptions,
  ) {
    this.onMalformed = opts?.onMalformed;
    this.onError = opts?.onError;
  }

  /** Append one record as a single line (atomic under O_APPEND). */
  record(e: LedgerEntry): void {
    try {
      if (!this.dirCreated) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.dirCreated = true;
      }
      appendFileSync(this.path, `${JSON.stringify(e)}\n`, { flag: "a" });
    } catch (err) {
      this.onError?.(err);
    }
  }

  /**
   * All records. Per-line tolerant: a single mangled/half-written line (e.g.
   * from an interrupted append) is skipped rather than aborting the rollup.
   */
  entries(): LedgerEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: LedgerEntry[] = [];
    let malformed = 0;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t === "") {
        continue;
      }
      try {
        const e = JSON.parse(t) as LedgerEntry;
        if (
          e &&
          typeof e.ts_utc === "string" &&
          typeof e.model === "string" &&
          typeof e.tokens_in === "number" &&
          Number.isFinite(e.tokens_in) &&
          typeof e.tokens_out === "number" &&
          Number.isFinite(e.tokens_out) &&
          typeof e.cost_usd === "number" &&
          Number.isFinite(e.cost_usd)
        ) {
          out.push(e);
        } else {
          malformed += 1;
        }
      } catch {
        malformed += 1;
      }
    }
    if (malformed > 0) {
      this.onMalformed?.(malformed);
    }
    return out;
  }

  /** Records within an optional `[since, until]` window (inclusive). */
  entriesIn(since?: Date, until?: Date): LedgerEntry[] {
    const lo = since?.getTime();
    const hi = until?.getTime();
    return this.entries().filter((e) => {
      const t = Date.parse(e.ts_utc);
      if (Number.isNaN(t)) {
        return false;
      }
      if (lo !== undefined && t < lo) {
        return false;
      }
      if (hi !== undefined && t > hi) {
        return false;
      }
      return true;
    });
  }

  /** Spend rolled up by period bucket within an optional window (sorted key). */
  rollup(period: Period, since?: Date, until?: Date): Map<string, Rollup> {
    const out = new Map<string, Rollup>();
    for (const e of this.entriesIn(since, until)) {
      const key = periodBucket(period, new Date(e.ts_utc));
      const r = out.get(key) ?? emptyRollup();
      r.cost_usd += e.cost_usd;
      r.tokens_in += e.tokens_in;
      r.tokens_out += e.tokens_out;
      r.calls += 1;
      out.set(key, r);
    }
    return new Map([...out.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  /** Spend grouped by model within an optional window. */
  byModel(since?: Date, until?: Date): Map<string, Rollup> {
    const out = new Map<string, Rollup>();
    for (const e of this.entriesIn(since, until)) {
      const r = out.get(e.model) ?? emptyRollup();
      r.cost_usd += e.cost_usd;
      r.tokens_in += e.tokens_in;
      r.tokens_out += e.tokens_out;
      r.calls += 1;
      out.set(e.model, r);
    }
    return new Map([...out.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}
