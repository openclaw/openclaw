// Active-tag-set rule (02-03): a stale box collapses on topic switch, but only after
// the anti-thrash dwell, only when the active set is meaningful, and never when noise
// turns are the only thing "moving on". Manual-expand head bumps keep a box live.
// Pure: data in → collapse decisions out (applyAutoCollapse is the I/O wrapper).
import { describe, expect, it } from "vitest";
import {
  ACTIVE_SET_CARDINALITY_FLOOR,
  ACTIVE_WINDOW_TURNS,
  COLLAPSE_DWELL_TURNS,
} from "./accordion-constants.js";
import {
  DEFAULT_PARAMS,
  decideAutoCollapse,
  type BoxLike,
  type CollapseParams,
  type SpanLike,
  type TurnLike,
} from "./active-tag-set.js";

// One non-noise turn per seq; channel/noise overridable.
function turn(seq: number, over: Partial<TurnLike> = {}): TurnLike {
  return { seq, content: `turn ${seq}`, channel: null, noise_class: null, ...over };
}
// One topic span per turn (start==end), assigned to a box.
function span(seq: number, topic: string, boxId: string, over: Partial<SpanLike> = {}): SpanLike {
  return { start_seq: seq, end_seq: seq, topic, box_id: boxId, noise_class: null, ...over };
}
function box(boxId: string, over: Partial<BoxLike> = {}): BoxLike {
  return { box_id: boxId, state: "live", last_active_seq: null, ...over };
}

// Builds a conversation: `voiceTurns` on box-voice/topic "voice", then `codeTurns`
// distinct coding topics on box-code so the active set is meaningfully large and the
// voice box's owned turns sit `codeTurns` behind the head.
function topicSwitch(voiceTurns: number, codeTurns: number) {
  const turns: TurnLike[] = [];
  const spans: SpanLike[] = [];
  let seq = 0;
  for (let i = 0; i < voiceTurns; i += 1) {
    seq += 1;
    turns.push(turn(seq));
    spans.push(span(seq, "voice", "box-voice"));
  }
  for (let i = 0; i < codeTurns; i += 1) {
    seq += 1;
    turns.push(turn(seq));
    spans.push(span(seq, `code-${i}`, "box-code")); // distinct topics → big active set
  }
  return { turns, spans, boxes: [box("box-voice"), box("box-code")] };
}

// Phase 4 LOCKED gemini-1 (zero-intersection) as the default; the jaccard-distance variant is
// still a supported CollapseParams shape, so these shared-mechanic tests pin it explicitly.
// (Pre-Phase-4 this was the default shape, which is why the fixtures keep "voice" inside the
// active window — partial overlap is the jaccard-distance trigger, not zero intersection.)
const JACCARD_PARAMS: CollapseParams = {
  mode: "jaccard-distance",
  activeWindowTurns: ACTIVE_WINDOW_TURNS,
  jaccardLiveCutoff: 0.3,
  collapseDwellTurns: COLLAPSE_DWELL_TURNS,
  activeSetCardinalityFloor: ACTIVE_SET_CARDINALITY_FLOOR,
};

describe("active-tag-set auto-collapse (jaccard-distance variant)", () => {
  it("collapses the stale box after a topic switch past the dwell", () => {
    const { turns, spans, boxes } = topicSwitch(2, COLLAPSE_DWELL_TURNS + 1);
    const collapsed = decideAutoCollapse({ turns, spans, boxes }, JACCARD_PARAMS);
    expect(collapsed).toEqual(["box-voice"]); // voice fell out of the active set
  });

  it("does not collapse before the anti-thrash dwell elapses", () => {
    // Only a couple of coding turns: voice is stale but still within the dwell window.
    const { turns, spans, boxes } = topicSwitch(2, COLLAPSE_DWELL_TURNS - 1);
    expect(decideAutoCollapse({ turns, spans, boxes }, JACCARD_PARAMS)).toEqual([]);
  });

  it("keeps the active topic's box live (high Jaccard overlap)", () => {
    const { turns, spans, boxes } = topicSwitch(2, COLLAPSE_DWELL_TURNS + 1);
    const collapsed = decideAutoCollapse({ turns, spans, boxes }, JACCARD_PARAMS);
    expect(collapsed).not.toContain("box-code");
  });

  it("excludes noise turns from the window so [SILENT]/heartbeat don't drive collapse", () => {
    // box-voice owns the only real topic; the 'movement' is all noise → no collapse,
    // because noise turns don't enter the active window or advance the dwell.
    const turns: TurnLike[] = [turn(1), turn(2)];
    const spans: SpanLike[] = [span(1, "voice", "box-voice"), span(2, "voice", "box-voice")];
    let seq = 2;
    for (let i = 0; i < COLLAPSE_DWELL_TURNS + 2; i += 1) {
      seq += 1;
      const noisy =
        i % 2 === 0 ? turn(seq, { content: "[SILENT] cron" }) : turn(seq, { channel: "heartbeat" });
      turns.push(noisy);
      spans.push(span(seq, `noise-${i}`, "box-noise"));
    }
    expect(decideAutoCollapse({ turns, spans, boxes: [box("box-voice")] }, JACCARD_PARAMS)).toEqual(
      [],
    );
  });

  it("suppresses collapse when the active set is below the cardinality floor", () => {
    // Single coding topic repeated → |active set| = 1 < floor, so nothing collapses
    // even though the voice box is far behind. (floor guards single-topic bursts.)
    expect(ACTIVE_SET_CARDINALITY_FLOOR).toBeGreaterThan(1);
    const turns: TurnLike[] = [turn(1), turn(2)];
    const spans: SpanLike[] = [span(1, "voice", "box-voice"), span(2, "voice", "box-voice")];
    let seq = 2;
    for (let i = 0; i < COLLAPSE_DWELL_TURNS + 2; i += 1) {
      seq += 1;
      turns.push(turn(seq));
      spans.push(span(seq, "code", "box-code")); // one topic only
    }
    const collapsed = decideAutoCollapse(
      { turns, spans, boxes: [box("box-voice"), box("box-code")] },
      JACCARD_PARAMS,
    );
    expect(collapsed).toEqual([]);
  });

  it("respects a manual-expand override via the last_active_seq head bump", () => {
    const { turns, spans } = topicSwitch(2, COLLAPSE_DWELL_TURNS + 1);
    const head = turns[turns.length - 1].seq;
    // Operator just expanded box-voice → last_active_seq bumped to the head; the dwell
    // now measures from the head, so it stays live until the topic genuinely moves on.
    const pinned = [box("box-voice", { last_active_seq: head }), box("box-code")];
    expect(decideAutoCollapse({ turns, spans, boxes: pinned }, JACCARD_PARAMS)).toEqual([]);
  });

  it("ignores already-collapsed and topic-less boxes", () => {
    const { turns, spans } = topicSwitch(2, COLLAPSE_DWELL_TURNS + 1);
    const boxes = [box("box-voice", { state: "collapsed" }), box("box-empty")];
    expect(decideAutoCollapse({ turns, spans, boxes }, JACCARD_PARAMS)).toEqual([]);
  });
});

// Phase 4 (04-01/04-04): the rule shape + thresholds are injected so the tuning harness can
// sweep candidates without mutating module state. DEFAULT_PARAMS is the locked gemini-1
// (zero-intersection) shape; the two candidate shapes must diverge on a shared fixture and be
// deterministic across repeated calls (no hidden global state).

// box-A owns {t2@seq1, t1@seq2}; box-B owns t3..t13 (seqs 3..13). t1 sits inside the
// last-12 active window so it joins the active set (partial overlap with box-A), but
// box-A's newest owned turn (seq 2) is 11 non-noise turns behind the head → past the
// dwell. grok-1 (jaccard < cutoff) collapses box-A; gemini-1 (any overlap = live) keeps
// it. box-B fully overlaps the active set and stays live under both.
function partialOverlap() {
  const turns: TurnLike[] = [turn(1), turn(2)];
  const spans: SpanLike[] = [span(1, "t2", "box-A"), span(2, "t1", "box-A")];
  for (let seq = 3; seq <= 13; seq += 1) {
    turns.push(turn(seq));
    spans.push(span(seq, `t${seq}`, "box-B"));
  }
  return { turns, spans, boxes: [box("box-A"), box("box-B")] };
}

const GROK_1: CollapseParams = {
  mode: "jaccard-distance",
  activeWindowTurns: 12,
  jaccardLiveCutoff: 0.3,
  collapseDwellTurns: 6,
  activeSetCardinalityFloor: 2,
};
const GEMINI_1: CollapseParams = {
  mode: "zero-intersection",
  activeWindowTurns: 12,
  zeroIntersectionDwellTurns: 5,
  activeSetCardinalityFloor: 2,
};

describe("decideAutoCollapse params (04-01/04-04)", () => {
  it("DEFAULT_PARAMS is the Phase-4-locked gemini-1 (zero-intersection) shape", () => {
    expect(DEFAULT_PARAMS).toEqual({
      mode: "zero-intersection",
      activeWindowTurns: ACTIVE_WINDOW_TURNS,
      zeroIntersectionDwellTurns: COLLAPSE_DWELL_TURNS,
      activeSetCardinalityFloor: ACTIVE_SET_CARDINALITY_FLOOR,
    });
  });

  it("default-arg parity: omitting params equals passing DEFAULT_PARAMS", () => {
    // Cover both a collapsing input (topic fully exits the window) and a still-live one.
    for (const codeTurns of [3, ACTIVE_WINDOW_TURNS + 1]) {
      const { turns, spans, boxes } = topicSwitch(2, codeTurns);
      expect(decideAutoCollapse({ turns, spans, boxes })).toEqual(
        decideAutoCollapse({ turns, spans, boxes }, DEFAULT_PARAMS),
      );
    }
  });

  it("default (locked zero-intersection) collapses a box once its topic leaves the window", () => {
    // > activeWindowTurns distinct code topics push "voice" out of the active window entirely
    // → empty intersection → collapse (past the dwell + cardinality floor).
    const { turns, spans, boxes } = topicSwitch(2, ACTIVE_WINDOW_TURNS + 1);
    expect(decideAutoCollapse({ turns, spans, boxes })).toEqual(["box-voice"]);
  });

  it("default keeps a box live while its topic still overlaps the active window", () => {
    const { turns, spans, boxes } = topicSwitch(2, 3); // voice still within the last-12 window
    expect(decideAutoCollapse({ turns, spans, boxes })).toEqual([]);
  });

  it("switching params alone changes which boxes collapse for identical input", () => {
    const input = partialOverlap();
    expect(decideAutoCollapse(input, GROK_1)).toEqual(["box-A"]);
    expect(decideAutoCollapse(input, GEMINI_1)).toEqual([]);
  });

  it("each candidate is deterministic across repeated calls (no global state)", () => {
    const input = partialOverlap();
    expect(decideAutoCollapse(input, GROK_1)).toEqual(decideAutoCollapse(input, GROK_1));
    expect(decideAutoCollapse(input, GEMINI_1)).toEqual(decideAutoCollapse(input, GEMINI_1));
    // The two shapes diverge on at least this fixture — the sweep is live.
    expect(decideAutoCollapse(input, GROK_1)).not.toEqual(decideAutoCollapse(input, GEMINI_1));
  });
});
