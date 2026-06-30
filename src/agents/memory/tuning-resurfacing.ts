/**
 * Deterministic resurfacing reference (Phase 4, 04-04 — TUNE-01). Zero model calls: from the
 * backfilled spans/boxes/entities, derive — per box — the set of non-noise seqs at which the
 * box is "still needed". A box is still needed at seq S if any topic or entity it owns appears
 * at seq >= S, INCLUDING across non-contiguous ranges (Pitfall 4: the Fidel SOL / Robin Wilder
 * recurrences resurface far apart). Light segmentation maps each topic to a stable box_id, so a
 * topic that recurs after a gap shows up as multiple spans sharing one box_id — non-contiguity
 * is captured for free. Entity reappearance crosses box boundaries and is supplied by the
 * harness as (boxId, seq) occurrences resolved from memory_associations.
 *
 * Pure: data in, reference out. No DB, no I/O — the harness reads the store and passes rows in.
 * Operates on non-noise turns only (Pitfall 3); `noise_class === "suppressed"` is the noise mark
 * the capture builder already stamped, so no content re-classification is needed here.
 */

/** Minimal turn shape: seq + the noise mark the capture builder stamped. */
export type ResurfacingTurnLike = { seq: number; noise_class?: string | null };

/** Minimal span shape: a topic range owned by a box. */
export type ResurfacingSpanLike = {
  start_seq: number;
  end_seq: number;
  topic?: string | null;
  box_id?: string | null;
  noise_class?: string | null;
};

/** Minimal box shape. */
export type ResurfacingBoxLike = { box_id: string };

export type ResurfacingReference = {
  /** Per box: sorted non-noise seqs at which the box is still needed (own topic OR owned entity). */
  neededSeqsByBox: Map<string, number[]>;
  /** Per box: sorted non-noise seqs the box itself owns (its turns — the context hidden on collapse). */
  ownedSeqsByBox: Map<string, number[]>;
  /** Total non-noise turns in history — the savings denominator. */
  totalNonNoiseTurns: number;
};

function sortedUnique(values: Iterable<number>): number[] {
  return [...new Set(values)].toSorted((a, b) => a - b);
}

export function buildResurfacingReference(input: {
  turns: readonly ResurfacingTurnLike[];
  spans: readonly ResurfacingSpanLike[];
  boxes: readonly ResurfacingBoxLike[];
  /** Per box: seqs at which an owned entity reappears anywhere in history (cross-box aware). */
  entitySeqsByBox?: ReadonlyMap<string, ReadonlySet<number>>;
}): ResurfacingReference {
  const nonNoiseSeqs = new Set<number>();
  for (const turn of input.turns) {
    if (turn.noise_class !== "suppressed") {
      nonNoiseSeqs.add(turn.seq);
    }
  }

  const ownedByBox = new Map<string, Set<number>>();
  const neededByBox = new Map<string, Set<number>>();
  const ensure = (map: Map<string, Set<number>>, boxId: string): Set<number> => {
    const existing = map.get(boxId);
    if (existing) {
      return existing;
    }
    const created = new Set<number>();
    map.set(boxId, created);
    return created;
  };

  // Topic ownership: every non-noise turn inside a box's (possibly non-contiguous) spans is both
  // owned by the box and a seq at which the box's topic is present.
  for (const span of input.spans) {
    if (!span.box_id || span.topic == null || span.noise_class === "suppressed") {
      continue;
    }
    const owned = ensure(ownedByBox, span.box_id);
    const needed = ensure(neededByBox, span.box_id);
    for (let seq = span.start_seq; seq <= span.end_seq; seq += 1) {
      if (!nonNoiseSeqs.has(seq)) {
        continue;
      }
      owned.add(seq);
      needed.add(seq);
    }
  }

  // Entity reappearance: an owned entity surfacing later (even under a different topic/box) keeps
  // the owning box "needed". Only count occurrences at real non-noise turns.
  for (const [boxId, seqs] of input.entitySeqsByBox ?? new Map<string, ReadonlySet<number>>()) {
    for (const seq of seqs) {
      if (nonNoiseSeqs.has(seq)) {
        ensure(neededByBox, boxId).add(seq);
      }
    }
  }

  const neededSeqsByBox = new Map<string, number[]>();
  const ownedSeqsByBox = new Map<string, number[]>();
  for (const box of input.boxes) {
    neededSeqsByBox.set(box.box_id, sortedUnique(neededByBox.get(box.box_id) ?? []));
    ownedSeqsByBox.set(box.box_id, sortedUnique(ownedByBox.get(box.box_id) ?? []));
  }

  return { neededSeqsByBox, ownedSeqsByBox, totalNonNoiseTurns: nonNoiseSeqs.size };
}
