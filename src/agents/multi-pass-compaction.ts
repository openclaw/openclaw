/**
 * Multi-pass compaction loop: wraps the existing single-pass
 * contextEngine.compact() with iterative progress checks,
 * anti-thrashing, and per-pass lifecycle management.
 *
 * Ported from Hermes Agent:
 *   agent/turn_context.py (lines 384-413, multi-pass loop)
 *   agent/conversation_compression.py (compress_context orchestration)
 *
 * This module lives in the GATEWAY layer (src/agents/) because it
 * references the context-engine CompactResult type, which agent-core
 * cannot import.
 */

import {
  CompactionProgressTracker,
  compactionMadeProgress,
  MAX_COMPACTION_PASSES,
  PROGRESS_THRESHOLD,
  DEFAULT_COMPACTION_TIMEOUT_MS,
  type MultiPassCompactionState,
} from "../../packages/agent-core/src/harness/compaction/compaction-progress.js";
import {
  shouldCompact,
  type CompactionSettings,
} from "../../packages/agent-core/src/harness/compaction/compaction.js";
import type { CompactResult, ContextEngine } from "../context-engine/types.js";

// -- Types --------------------------------------------------------------------

/** Parameters forwarded to contextEngine.compact() on each pass. */
type CompactionPassParams = Parameters<ContextEngine["compact"]>[0];

/**
 * Result of a multi-pass compaction invocation.
 *
 * Lives in the gateway layer because lastCompactResult uses the
 * context-engine CompactResult type (with .ok, .compacted,
 * .result?.tokensAfter), which agent-core cannot import.
 */
export interface MultiPassCompactionResult {
  /** Per-pass diagnostic states. */
  passes: readonly MultiPassCompactionState[];
  /** Total passes executed. */
  totalPasses: number;
  /** Final token count after all passes. */
  finalTokens: number;
  /** Whether compaction brought context below the threshold. */
  metThreshold: boolean;
  /** Reason the loop stopped. */
  stopReason:
    | "threshold_met"
    | "no_progress"
    | "max_passes"
    | "timeout"
    | "aborted"
    | "anti_thrash";
  /** Total elapsed time across all passes in ms. */
  totalElapsedMs: number;
  /**
   * The CompactResult from the last successful pass.
   * This is the CONTEXT ENGINE CompactResult (type B):
   *   { ok, compacted, reason?, result?: { tokensAfter?, ... } }
   */
  lastCompactResult?: CompactResult;
}

/** Full parameter set for multiPassCompact(). */
export interface MultiPassCompactParams {
  /** The context engine to compact. */
  contextEngine: Pick<ContextEngine, "compact">;
  /** Parameters for each contextEngine.compact() call. */
  compactParams: CompactionPassParams;
  /** Settings controlling loop behavior. */
  settings: CompactionSettings;
  /** Context window size for shouldCompact checks. */
  contextWindow: number;
  /** Anti-thrashing tracker (shared across invocations). */
  tracker: CompactionProgressTracker;
  /** Called after each successful pass to adopt session state. */
  adoptTranscript: (result: CompactResult) => void;
  /** Optional: called after each successful pass for engine maintenance. */
  runMaintenance?: () => Promise<void>;
  /** Total timeout for all passes (ms). @default 180_000 */
  timeoutMs?: number;
  /** External abort signal (e.g., from run-level abort). */
  abortSignal?: AbortSignal;
  /** Logger for diagnostics. */
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

// -- Constants ----------------------------------------------------------------

/** Hard upper bound on maxPasses to prevent configuration errors. */
const MAX_PASSES_UPPER_BOUND = 10;

// -- Main Function ------------------------------------------------------------

/**
 * Execute multi-pass compaction: iterate until the token count
 * drops below the threshold or progress stalls.
 *
 * On each pass:
 *   1. Call contextEngine.compact()
 *   2. If successful, call adoptTranscript + runMaintenance
 *   3. Check progress (>5% token reduction)
 *   4. Check if tokens are below threshold
 *
 * The loop is bounded by:
 *   - settings.maxPasses (default 3, clamped to [1, 10])
 *   - Total timeout across all passes
 *   - Progress stall detection
 *   - Anti-thrashing guard
 *   - External abort signal
 */
export async function multiPassCompact(
  params: MultiPassCompactParams,
): Promise<MultiPassCompactionResult> {
  const {
    contextEngine,
    compactParams,
    settings,
    contextWindow,
    tracker,
    adoptTranscript,
    runMaintenance,
    timeoutMs = DEFAULT_COMPACTION_TIMEOUT_MS,
    abortSignal,
    logger: log,
  } = params;

  // Clamp maxPasses to [1, MAX_PASSES_UPPER_BOUND]
  const rawMaxPasses = settings.maxPasses ?? MAX_COMPACTION_PASSES;
  const maxPasses = Math.max(1, Math.min(Math.floor(rawMaxPasses), MAX_PASSES_UPPER_BOUND));
  const progressThreshold = settings.progressThreshold ?? PROGRESS_THRESHOLD;
  const passes: MultiPassCompactionState[] = [];
  let lastCompactResult: CompactResult | undefined;
  const startTime = Date.now();

  // -- Anti-thrashing gate --
  if (tracker.shouldSuppressCompaction()) {
    log?.warn?.(
      "[multi-pass] compaction suppressed by anti-thrashing guard " +
        `(${tracker.getState().consecutiveIneffective} consecutive ineffective passes)`,
    );
    return buildResult(passes, lastCompactResult, "anti_thrash", startTime);
  }

  // -- Create composed timeout signal --
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  const composedSignal = abortSignal
    ? AbortSignal.any([abortSignal, timeoutController.signal])
    : timeoutController.signal;

  try {
    for (let pass = 0; pass < maxPasses; pass++) {
      const passStart = Date.now();

      // Check for abort/timeout before each pass
      if (composedSignal.aborted) {
        return buildResult(
          passes,
          lastCompactResult,
          abortSignal?.aborted ? "aborted" : "timeout",
          startTime,
        );
      }

      // -- Execute one compaction pass --
      let compactResult: CompactResult;
      try {
        compactResult = await contextEngine.compact({
          ...compactParams,
          abortSignal: composedSignal,
        });
      } catch (err) {
        // Compaction threw -- check if it was a timeout or abort
        if (composedSignal.aborted) {
          return buildResult(
            passes,
            lastCompactResult,
            abortSignal?.aborted ? "aborted" : "timeout",
            startTime,
          );
        }
        throw err; // Re-throw unexpected errors
      }

      // -- Evaluate pass result --
      if (!compactResult.ok || !compactResult.compacted) {
        // Pass did not compact -- record and stop
        passes.push({
          pass,
          tokensBefore: compactResult.result?.tokensBefore ?? 0,
          tokensAfter: compactResult.result?.tokensAfter ?? compactResult.result?.tokensBefore ?? 0,
          madeProgress: false,
          elapsedMs: Date.now() - passStart,
        });
        return buildResult(passes, compactResult, "no_progress", startTime);
      }

      // -- Pass succeeded --
      const tokensBefore = compactResult.result?.tokensBefore ?? 0;
      const tokensAfter = compactResult.result?.tokensAfter ?? tokensBefore;

      passes.push({
        pass,
        tokensBefore,
        tokensAfter,
        madeProgress: true,
        elapsedMs: Date.now() - passStart,
      });

      lastCompactResult = compactResult;

      // -- Record pass outcome for cross-invocation anti-thrashing --
      // (V3 review fix: tracker must be updated per-pass so anti-thrash
      //  can activate organically in production, not just in tests)
      tracker.recordCompaction(tokensBefore, tokensAfter);

      // -- Per-pass lifecycle --
      adoptTranscript(compactResult);
      if (runMaintenance) {
        await runMaintenance();
      }

      // -- Check if below threshold --
      if (!shouldCompact(tokensAfter, contextWindow, settings)) {
        return buildResult(passes, lastCompactResult, "threshold_met", startTime);
      }

      // -- Check progress --
      if (!compactionMadeProgress(tokensBefore, tokensAfter, progressThreshold)) {
        // Update pass state to reflect no progress
        passes[passes.length - 1].madeProgress = false;
        return buildResult(passes, lastCompactResult, "no_progress", startTime);
      }
    }

    // -- Exhausted max passes --
    return buildResult(passes, lastCompactResult, "max_passes", startTime);
  } finally {
    clearTimeout(timeoutId);
  }
}

// -- Helpers ------------------------------------------------------------------

function buildResult(
  passes: MultiPassCompactionState[],
  lastCompactResult: CompactResult | undefined,
  stopReason: MultiPassCompactionResult["stopReason"],
  startTime: number,
): MultiPassCompactionResult {
  const lastPass = passes[passes.length - 1];
  const finalTokens = lastPass?.tokensAfter ?? 0;
  return {
    passes,
    totalPasses: passes.length,
    finalTokens,
    metThreshold: stopReason === "threshold_met",
    stopReason,
    totalElapsedMs: Date.now() - startTime,
    lastCompactResult,
  };
}
