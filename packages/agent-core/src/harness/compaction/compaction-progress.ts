/**
 * Multi-pass compaction progress detection and anti-thrashing.
 *
 * Provides:
 * - Constants governing multi-pass iteration limits
 * - `compactionMadeProgress()` -- per-pass progress check
 * - `CompactionProgressTracker` -- cross-invocation anti-thrashing guard
 *
 * Ported from Hermes Agent:
 *   agent/turn_context.py  (lines 41-61, _compression_made_progress)
 *   agent/context_compressor.py (lines 964-984, should_compress anti-thrash)
 */

// -- Constants ----------------------------------------------------------------

/** Maximum number of compaction passes per invocation. */
export const MAX_COMPACTION_PASSES = 3;

/** Minimum token reduction (fraction) to count as progress. */
export const PROGRESS_THRESHOLD = 0.05;

/** Savings percentage below which a compaction is "ineffective". */
export const INEFFECTIVE_SAVINGS_THRESHOLD = 0.1;

/**
 * Consecutive ineffective compressions before suppressing further
 * attempts. Mirrors Hermes's `_ineffective_compression_count >= 2`.
 */
export const MAX_INEFFECTIVE_COMPRESSIONS = 2;

/** Default safety timeout for the full multi-pass loop (ms). */
export const DEFAULT_COMPACTION_TIMEOUT_MS = 180_000;

// -- Interfaces ---------------------------------------------------------------

/**
 * Diagnostic state captured after each compaction pass.
 * Only primitive fields -- no external type references.
 */
export interface MultiPassCompactionState {
  /** Zero-indexed pass number. */
  pass: number;
  /** Token count before this pass ran. */
  tokensBefore: number;
  /** Token count after this pass completed. */
  tokensAfter: number;
  /** Whether compactionMadeProgress returned true. */
  madeProgress: boolean;
  /** Wall-clock time for this pass in ms. */
  elapsedMs: number;
}

/**
 * Serializable snapshot of the anti-thrashing tracker.
 * Used for diagnostics and tests.
 */
export interface CompactionProgressTrackerState {
  consecutiveIneffective: number;
  lastSavingsPct: number;
  totalCompactions: number;
}

// -- Progress Detection -------------------------------------------------------

/**
 * Returns true if a compaction pass materially reduced the context.
 *
 * Progress = tokens decreased by more than the configured threshold
 * (default 5%). A sub-threshold wobble does not count as progress and
 * stops the multi-pass loop.
 *
 * Hermes also checks message-count reduction; we use token-only detection
 * because the multi-pass loop has no direct access to message counts. Any
 * meaningful compaction that reduces message count also reduces token count.
 */
export function compactionMadeProgress(
  tokensBefore: number,
  tokensAfter: number,
  threshold: number = PROGRESS_THRESHOLD,
): boolean {
  if (tokensBefore <= 0) {
    return false;
  }
  return tokensAfter < tokensBefore * (1 - threshold);
}

// -- Anti-Thrashing Tracker ---------------------------------------------------

/**
 * Tracks compaction effectiveness across invocations within a session.
 *
 * Records whether each compaction achieved meaningful savings (>= 10%
 * token reduction). After {@link MAX_INEFFECTIVE_COMPRESSIONS} (2)
 * consecutive passes below the threshold, the tracker signals that
 * further compaction should be suppressed to prevent thrashing.
 */
export class CompactionProgressTracker {
  private consecutiveIneffective = 0;
  private lastSavingsPct = 0;
  private totalCompactions = 0;

  /**
   * Record the outcome of a compaction pass.
   * @param tokensBefore Token count before compaction.
   * @param tokensAfter  Token count after compaction.
   */
  recordCompaction(tokensBefore: number, tokensAfter: number): void {
    this.totalCompactions++;
    if (tokensBefore <= 0) {
      this.lastSavingsPct = 0;
      this.consecutiveIneffective++;
      return;
    }
    this.lastSavingsPct = (tokensBefore - tokensAfter) / tokensBefore;
    if (this.lastSavingsPct < INEFFECTIVE_SAVINGS_THRESHOLD) {
      this.consecutiveIneffective++;
    } else {
      this.consecutiveIneffective = 0;
    }
  }

  /**
   * Returns true if compaction should be suppressed due to
   * consecutive ineffective passes.
   */
  shouldSuppressCompaction(): boolean {
    return this.consecutiveIneffective >= MAX_INEFFECTIVE_COMPRESSIONS;
  }

  /** Reset tracker state (e.g., on session reset or /new). */
  reset(): void {
    this.consecutiveIneffective = 0;
    this.lastSavingsPct = 0;
    this.totalCompactions = 0;
  }

  /** Snapshot for diagnostics. */
  getState(): CompactionProgressTrackerState {
    return {
      consecutiveIneffective: this.consecutiveIneffective,
      lastSavingsPct: this.lastSavingsPct,
      totalCompactions: this.totalCompactions,
    };
  }
}
