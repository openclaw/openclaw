// Resurfacing reference + recall-safety-first objective (04-04 Task 1). Pure fixtures, no DB.
// Proves: (a) a box collapsed before its reappearance is a recall failure; (b) two timelines
// equal on savings rank by recall failures first (recall-safety dominance, D-09); (c) the
// reference flags a NON-contiguous reappearance as "still needed" (Pitfall 4).
import { describe, expect, it } from "vitest";
import { scoreCandidate } from "./tuning-objective.js";
import {
  buildResurfacingReference,
  type ResurfacingSpanLike,
  type ResurfacingTurnLike,
} from "./tuning-resurfacing.js";

function nonNoiseTurns(count: number): ResurfacingTurnLike[] {
  return Array.from({ length: count }, (_, i) => ({ seq: i + 1, noise_class: null }));
}

function span(boxId: string, topic: string, startSeq: number, endSeq: number): ResurfacingSpanLike {
  return { start_seq: startSeq, end_seq: endSeq, topic, box_id: boxId, noise_class: null };
}

describe("buildResurfacingReference", () => {
  it("flags a non-contiguous topic reappearance as still needed (Pitfall 4)", () => {
    // Box B's topic appears at 1-3, goes away, then resurfaces at 8-10.
    const reference = buildResurfacingReference({
      turns: nonNoiseTurns(10),
      spans: [span("box-B", "sol", 1, 3), span("box-B", "sol", 8, 10)],
      boxes: [{ box_id: "box-B" }],
    });
    const needed = reference.neededSeqsByBox.get("box-B");
    expect(needed).toContain(8); // the post-gap recurrence is "still needed", not "done at 3"
    expect(needed).toEqual([1, 2, 3, 8, 9, 10]);
  });

  it("treats an entity reappearance as still-needed even when no later span is owned", () => {
    // Box B owns only 3-4, but an owned entity resurfaces at seq 9 (cross-topic recurrence).
    const reference = buildResurfacingReference({
      turns: nonNoiseTurns(10),
      spans: [span("box-B", "beta", 3, 4)],
      boxes: [{ box_id: "box-B" }],
      entitySeqsByBox: new Map([["box-B", new Set([9])]]),
    });
    expect(reference.ownedSeqsByBox.get("box-B")).toEqual([3, 4]); // owns only its turns
    expect(reference.neededSeqsByBox.get("box-B")).toEqual([3, 4, 9]); // but needed at 9 too
  });
});

describe("scoreCandidate", () => {
  it("counts a box collapsed before its documented reappearance as a recall failure", () => {
    const reference = buildResurfacingReference({
      turns: nonNoiseTurns(10),
      spans: [span("box-B", "sol", 1, 3), span("box-B", "sol", 8, 10)],
      boxes: [{ box_id: "box-B" }],
    });
    const score = scoreCandidate({ events: [{ boxId: "box-B", collapseSeq: 5 }] }, reference);
    expect(score.recallFailures).toBe(1); // collapsed at 5, needed again at 8
  });

  it("ranks recall-safety above savings: equal savings, the timeline with a failure scores worse", () => {
    // B1 (owns 1-2) is never needed again; B2 (owns 3-4) has an entity resurface at 9.
    const reference = buildResurfacingReference({
      turns: nonNoiseTurns(10),
      spans: [span("box-1", "alpha", 1, 2), span("box-2", "beta", 3, 4)],
      boxes: [{ box_id: "box-1" }, { box_id: "box-2" }],
      entitySeqsByBox: new Map([["box-2", new Set([9])]]),
    });
    // Both collapse at seq 6 and hide exactly 2 owned turns → identical savings.
    const safe = scoreCandidate({ events: [{ boxId: "box-1", collapseSeq: 6 }] }, reference);
    const unsafe = scoreCandidate({ events: [{ boxId: "box-2", collapseSeq: 6 }] }, reference);

    expect(safe.savings).toBe(unsafe.savings); // tie on the secondary term
    expect(safe.recallFailures).toBe(0);
    expect(unsafe.recallFailures).toBe(1);
    expect(safe.value).toBeGreaterThan(unsafe.value); // recall safety dominates the ranking
  });
});
