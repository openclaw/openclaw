/**
 * Adaptive Model Routing – Token Savings Ledger
 *
 * Tracks per-run token usage split by local vs cloud so users can see how
 * many tokens were processed locally (for free/cheap) versus escalated to
 * the cloud model.
 *
 * Stored at: <stateDir>/adaptive-routing-savings.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { NormalizedUsage } from "./usage.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AdaptiveRoutingTokenRecord = {
  /** Tokens used by the local model run (always present when AR fires). */
  localTokensInput: number;
  localTokensOutput: number;
  localTokensCacheRead: number;
  /** Tokens used by the cloud escalation run (0 when no escalation). */
  cloudTokensInput: number;
  cloudTokensOutput: number;
};

export type AdaptiveRoutingSavingsLedger = {
  /** Schema version for forward-compat. */
  version: 1;
  /** ISO timestamp when the ledger was first created. */
  since: string;
  /** ISO timestamp of the last update. */
  lastUpdated: string;
  totals: {
    /** Total adaptive-routing runs (local + escalated; excludes bypassed). */
    runsTotal: number;
    /** Runs fully handled by local model (validation passed, no escalation). */
    runsLocal: number;
    /** Runs that escalated to the cloud model after local validation failure. */
    runsEscalated: number;
    /** Runs where adaptive routing was bypassed (explicit override, disabled). */
    runsBypassed: number;
    /** Cumulative tokens processed by the local model. */
    localTokensInput: number;
    localTokensOutput: number;
    localTokensCacheRead: number;
    /** Cumulative tokens sent to the cloud escalation model. */
    cloudTokensInput: number;
    cloudTokensOutput: number;
    /** Tokens from local-success runs only (v2 field, backfilled as 0). */
    localSuccessTokensInput?: number;
    localSuccessTokensOutput?: number;
  };
};

const SAVINGS_FILENAME = "adaptive-routing-savings.json";
const SCHEMA_VERSION = 1 as const;

// ─── I/O helpers ─────────────────────────────────────────────────────────────

export function savingsFilePath(stateDir: string): string {
  return path.join(stateDir, SAVINGS_FILENAME);
}

function emptyLedger(): AdaptiveRoutingSavingsLedger {
  const now = new Date().toISOString();
  return {
    version: SCHEMA_VERSION,
    since: now,
    lastUpdated: now,
    totals: {
      runsTotal: 0,
      runsLocal: 0,
      runsEscalated: 0,
      runsBypassed: 0,
      localTokensInput: 0,
      localTokensOutput: 0,
      localTokensCacheRead: 0,
      cloudTokensInput: 0,
      cloudTokensOutput: 0,
    },
  };
}

export async function readSavingsLedger(stateDir: string): Promise<AdaptiveRoutingSavingsLedger> {
  const filePath = savingsFilePath(stateDir);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AdaptiveRoutingSavingsLedger;
    // Tolerate missing fields from older schema versions.
    if (!parsed?.totals) {
      return emptyLedger();
    }
    return {
      ...emptyLedger(),
      ...parsed,
      totals: { ...emptyLedger().totals, ...parsed.totals },
    };
  } catch {
    return emptyLedger();
  }
}

async function writeSavingsLedger(
  stateDir: string,
  ledger: AdaptiveRoutingSavingsLedger,
): Promise<void> {
  const filePath = savingsFilePath(stateDir);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(ledger, null, 2), "utf8");
}

// ─── Accumulation ─────────────────────────────────────────────────────────────

function tokensFromUsage(usage?: NormalizedUsage | null): {
  input: number;
  output: number;
  cacheRead: number;
} {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
  };
}

export type RecordAdaptiveRunParams =
  | {
      kind: "bypassed";
    }
  | {
      kind: "local_success";
      localUsage?: NormalizedUsage | null;
    }
  | {
      kind: "escalated";
      localUsage?: NormalizedUsage | null;
      cloudUsage?: NormalizedUsage | null;
    };

/**
 * Append one run's outcome to the savings ledger.
 * Uses a read-modify-write with best-effort (fire-and-forget): errors are
 * swallowed so a ledger write failure never breaks an agent run.
 *
 * Concurrency note: This uses a simple read-modify-write without file locking.
 * Concurrent agent runs may race, causing some ledger updates to be lost.
 * This is acceptable for best-effort telemetry — token savings are approximate.
 * If accurate counting is required in the future, consider using proper file
 * locking or an atomic append-only log format.
 */
export async function recordAdaptiveRun(
  stateDir: string,
  params: RecordAdaptiveRunParams,
): Promise<void> {
  try {
    const ledger = await readSavingsLedger(stateDir);
    const t = ledger.totals;

    if (params.kind === "bypassed") {
      t.runsBypassed += 1;
    } else {
      t.runsTotal += 1;
      if (params.kind === "local_success") {
        t.runsLocal += 1;
        const local = tokensFromUsage(params.localUsage);
        t.localTokensInput += local.input;
        t.localTokensOutput += local.output;
        t.localTokensCacheRead += local.cacheRead;
        // Track local-success-only tokens separately for accurate savings.
        t.localSuccessTokensInput = (t.localSuccessTokensInput ?? 0) + local.input;
        t.localSuccessTokensOutput = (t.localSuccessTokensOutput ?? 0) + local.output;
      } else {
        // escalated
        t.runsEscalated += 1;
        const local = tokensFromUsage(params.localUsage);
        const cloud = tokensFromUsage(params.cloudUsage);
        t.localTokensInput += local.input;
        t.localTokensOutput += local.output;
        t.localTokensCacheRead += local.cacheRead;
        t.cloudTokensInput += cloud.input;
        t.cloudTokensOutput += cloud.output;
      }
    }

    ledger.lastUpdated = new Date().toISOString();
    await writeSavingsLedger(stateDir, ledger);
  } catch {
    // Never surface ledger errors to callers.
  }
}

// ─── Formatting helpers (used by CLI stats command) ───────────────────────────

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

export function pct(num: number, den: number): string {
  if (den === 0) {
    return "—";
  }
  return `${Math.round((num / den) * 100)}%`;
}

/**
 * Compute derived savings metrics from the ledger.
 * "Cloud-saved tokens" = tokens that ran locally on a successful local run,
 * i.e., tokens that *would have* gone to the cloud model if AR was disabled.
 * These are approximated as the local tokens from successful (non-escalated) runs.
 */
export function computeSavingsMetrics(ledger: AdaptiveRoutingSavingsLedger) {
  const t = ledger.totals;

  // Token-level savings: for escalated runs, both local AND cloud tokens were used.
  // For local-success runs, only local tokens were used (cloud was skipped).
  // Use the tracked per-run-type tokens when available (v2 field); fall back to
  // the proportional estimate for ledgers created before the field existed.
  const hasPerRunTypeTokens =
    t.localSuccessTokensInput != null && t.localSuccessTokensOutput != null;
  const localOnlyTokens = hasPerRunTypeTokens
    ? (t.localSuccessTokensInput ?? 0) + (t.localSuccessTokensOutput ?? 0)
    : t.runsLocal === 0
      ? 0
      : Math.round(
          (t.localTokensInput + t.localTokensOutput) * (t.runsLocal / Math.max(1, t.runsTotal)),
        );

  const cloudTotal = t.cloudTokensInput + t.cloudTokensOutput;
  const localTotal = t.localTokensInput + t.localTokensOutput + t.localTokensCacheRead;

  return {
    runsTotal: t.runsTotal,
    runsLocal: t.runsLocal,
    runsEscalated: t.runsEscalated,
    runsBypassed: t.runsBypassed,
    localTotal,
    cloudTotal,
    // Tokens processed entirely on the local model (no cloud charge).
    cloudSavedTokens: localOnlyTokens,
    savingsRate: pct(t.runsLocal, t.runsTotal),
    since: ledger.since,
    lastUpdated: ledger.lastUpdated,
  };
}
