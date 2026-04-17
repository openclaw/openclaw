/** Pressure thresholds for context pressure signaling. */
const PRESSURE_SILENT = 0.75;
const PRESSURE_RECOMMEND = 0.85;

/** Track last emitted pressure to avoid redundant signals below RECOMMEND threshold. */
let lastEmittedPressure: number | null = null;

/**
 * One-shot suppression flag set by `resetPressureTracking()` (which is invoked
 * post-compaction). The first call to `computeContextPressure()` after a reset
 * is suppressed regardless of pressure level.
 *
 * Why: the signal is computed from token counts that may still reflect the
 * pre-compaction transcript (e.g. estimated from an on-disk transcript that
 * hasn't been rewritten yet, or from a prior turn's API usage report). Without
 * this flag, the turn immediately after compaction would re-emit the same
 * `compaction_recommended: true` signal we just acted on, telling the agent to
 * compact again. We skip exactly one emission cycle so the next signal is
 * recomputed from a fresh, post-compaction token count.
 */
let suppressNextSignal = false;

export interface ContextPressureSignal {
  pressure: number;
  compactionRecommended: boolean;
}

/**
 * Compute context pressure from actual API-reported token counts.
 * Returns null if pressure is below the signaling threshold or data is unavailable.
 */
export function computeContextPressure(params: {
  totalTokens?: number;
  contextWindowTokens: number;
}): ContextPressureSignal | null {
  const { totalTokens, contextWindowTokens } = params;

  if (!totalTokens || totalTokens <= 0 || !contextWindowTokens || contextWindowTokens <= 0) {
    return null;
  }

  const pressure = totalTokens / contextWindowTokens;

  if (pressure < PRESSURE_SILENT) {
    return null;
  }

  // One-shot post-compaction suppression. See `suppressNextSignal` doc above.
  if (suppressNextSignal) {
    suppressNextSignal = false;
    lastEmittedPressure = null;
    return null;
  }

  const compactionRecommended = pressure >= PRESSURE_RECOMMEND;
  const roundedPressure = Math.round(pressure * 100) / 100;

  // Below RECOMMEND: notify once, then stay silent until crossing RECOMMEND.
  if (!compactionRecommended) {
    if (lastEmittedPressure !== null) {
      return null;
    }
    lastEmittedPressure = roundedPressure;
    return { pressure: roundedPressure, compactionRecommended };
  }

  // At or above RECOMMEND: always emit (every turn).
  lastEmittedPressure = roundedPressure;
  return { pressure: roundedPressure, compactionRecommended };
}

/** Reset pressure tracking (call after compaction).
 *
 * Clears `lastEmittedPressure` AND arms a one-shot suppression so the very next
 * `computeContextPressure()` call returns null. This prevents a duplicate
 * `compaction_recommended` signal from being emitted on the turn immediately
 * after compaction, when token-count inputs may still reflect pre-compaction
 * state.
 */
export function resetPressureTracking(): void {
  lastEmittedPressure = null;
  suppressNextSignal = true;
}

/** Test-only: fully reset state, including clearing the post-compaction
 * suppression flag. Production code should call `resetPressureTracking()`. */
export function _resetPressureTrackingForTests(): void {
  lastEmittedPressure = null;
  suppressNextSignal = false;
}

/**
 * Format a context pressure signal as a system message string.
 */
export function formatContextPressureMessage(signal: ContextPressureSignal): string {
  const tag = signal.compactionRecommended
    ? `[context_pressure: ${signal.pressure}, compaction_recommended: true]`
    : `[context_pressure: ${signal.pressure}]`;

  if (!signal.compactionRecommended) {
    return tag;
  }

  return (
    tag +
    "\n\nContext is filling up. Call `compact` with a summary at your next natural break point.\n\n" +
    "**Compaction guidelines:** " +
    "Structure: Goal → Decisions → Progress → Open TODOs → Next Steps. " +
    "Keep ONLY what's needed to continue. Drop completed work details, exact identifiers, " +
    "and anything already in workspace files. Preserve pending user asks verbatim. " +
    "Be concise (1500-3000 chars)."
  );
}
