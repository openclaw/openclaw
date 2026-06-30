/**
 * Recall-safety-first tuning objective (Phase 4, 04-04 — D-09). Pure: given the collapse
 * timeline a candidate rule produced and the resurfacing reference (04-04 tuning-resurfacing),
 * return a closed score. The accordion only ever auto-collapses (never auto-re-expands), so a
 * box collapsed at seq S and then needed at S' > S stays hidden when the operator needs it —
 * that is the recall-safety failure this objective penalizes HARDEST. Context savings (turns
 * tucked away) is a strictly secondary reward, and a small anti-thrash term discounts collapses
 * that a near-future recurrence reopens. `value` is built so recall failures dominate any
 * realistic savings: W_RECALL >> W_SAVINGS (savings is a [0,1] fraction).
 *
 * Pure: numbers in, numbers out. No DB, no I/O.
 */
import type { ResurfacingReference } from "./tuning-resurfacing.js";

/** One box collapsing at a seq, as produced by a candidate replay. */
export type CollapseEvent = { boxId: string; collapseSeq: number };

/** A candidate's collapse decisions over the replayed history. */
export type CollapseTimeline = {
  events: readonly CollapseEvent[];
};

/** Closed score shape. Higher `value` is better; recall failures dominate. */
export type CandidateScore = {
  recallFailures: number;
  savings: number;
  thrash: number;
  value: number;
};

// Recall safety dominates: one premature collapse outweighs any savings/thrash difference
// (savings is a [0,1] fraction, so W_SAVINGS can never overcome a single W_RECALL).
const W_RECALL = 1_000_000;
const W_SAVINGS = 1_000;
const W_THRASH = 10;
// A recurrence within this many seqs of the collapse counts as thrash (near-miss reopen).
const THRASH_WINDOW = 4;

/** First needed seq strictly after `seq`, or undefined if the box is never needed again. */
function nextNeededAfter(
  neededSeqs: readonly number[] | undefined,
  seq: number,
): number | undefined {
  if (!neededSeqs) {
    return undefined;
  }
  for (const needed of neededSeqs) {
    if (needed > seq) {
      return needed;
    }
  }
  return undefined;
}

export function scoreCandidate(
  timeline: CollapseTimeline,
  reference: ResurfacingReference,
): CandidateScore {
  let recallFailures = 0;
  let thrash = 0;
  let hiddenTurns = 0;

  for (const event of timeline.events) {
    const needed = reference.neededSeqsByBox.get(event.boxId);
    const reappear = nextNeededAfter(needed, event.collapseSeq);
    if (reappear !== undefined) {
      recallFailures += 1;
      if (reappear - event.collapseSeq <= THRASH_WINDOW) {
        thrash += 1;
      }
    }
    // Every collapse hides its box's own turns from live context (the savings, even if the
    // collapse was premature — recall is penalized separately).
    hiddenTurns += reference.ownedSeqsByBox.get(event.boxId)?.length ?? 0;
  }

  const savings = reference.totalNonNoiseTurns > 0 ? hiddenTurns / reference.totalNonNoiseTurns : 0;
  const value = -(W_RECALL * recallFailures) + W_SAVINGS * savings - W_THRASH * thrash;

  return { recallFailures, savings, thrash, value };
}
