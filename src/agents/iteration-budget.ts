/**
 * Per-agent iteration budget with consume/refund semantics.
 *
 * Ported from Hermes `agent/iteration_budget.py`. Each embedded agent run
 * (parent or subagent) holds an {@link IterationBudget}; the parent's cap
 * comes from `maxIterations` (default 90), each subagent's cap comes from
 * `subagentMaxIterations` (default 50).
 *
 * Programmatic tool calls (e.g. compaction restarts) are refunded via
 * {@link IterationBudget.refund} so they don't eat into the budget.
 */

import type { IterationBudgetConfig } from "../config/types.agent-defaults.js";

/** Resolved iteration budget configuration with all defaults applied. */
export interface ResolvedIterationBudgetConfig {
  enabled: boolean;
  maxIterations: number;
  subagentMaxIterations: number;
  forceSummaryOnExhaustion: boolean;
}

// Hardcoded defaults matching Hermes: 90 for parent, 50 for subagent.
const DEFAULT_MAX_ITERATIONS = 90;
const DEFAULT_SUBAGENT_MAX_ITERATIONS = 50;
const DEFAULT_FORCE_SUMMARY_ON_EXHAUSTION = true;

/**
 * Resolve raw iteration budget configuration into a fully-populated config
 * with hardcoded defaults for any missing fields.
 *
 * Analogous to `resolveMaxRunRetryIterations` in run/helpers.ts -- this is
 * the "Layer 2" consumption-site resolution that applies per-field defaults.
 *
 * Returns `undefined` when the input is nullish, allowing callers to
 * distinguish "no config at all" from "config present but sparse".
 */
export function resolveIterationBudgetConfig(
  raw: IterationBudgetConfig | undefined | null,
): ResolvedIterationBudgetConfig | undefined {
  if (raw == null) {
    return undefined;
  }
  return {
    enabled: raw.enabled ?? false,
    maxIterations: raw.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    subagentMaxIterations: raw.subagentMaxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS,
    forceSummaryOnExhaustion: raw.forceSummaryOnExhaustion ?? DEFAULT_FORCE_SUMMARY_ON_EXHAUSTION,
  };
}

/**
 * Iteration counter for an agent run.
 *
 * Node.js is single-threaded so no lock is needed (unlike the Python
 * original which uses `threading.Lock`). The API surface is kept
 * identical for symmetry with Hermes.
 */
export class IterationBudget {
  public readonly maxTotal: number;
  private usedCount = 0;

  constructor(maxTotal: number) {
    if (maxTotal < 0) {
      throw new RangeError(`maxTotal must be non-negative, got ${maxTotal}`);
    }
    this.maxTotal = maxTotal;
  }

  /** Try to consume one iteration. Returns `true` if allowed. */
  consume(): boolean {
    if (this.usedCount >= this.maxTotal) {
      return false;
    }
    this.usedCount += 1;
    return true;
  }

  /** Give back one iteration (e.g. for compaction restarts). */
  refund(): void {
    if (this.usedCount > 0) {
      this.usedCount -= 1;
    }
  }

  /** Number of iterations consumed so far. */
  get used(): number {
    return this.usedCount;
  }

  /** Number of iterations remaining before exhaustion. */
  get remaining(): number {
    return Math.max(0, this.maxTotal - this.usedCount);
  }
}
