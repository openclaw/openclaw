// Active-tag-set rule (02-03): a stale box collapses on topic switch, but only after
// the anti-thrash dwell, only when the active set is meaningful, and never when noise
// turns are the only thing "moving on". Manual-expand head bumps keep a box live.
// Pure: data in → collapse decisions out (applyAutoCollapse is the I/O wrapper).
import { describe, expect, it } from "vitest";
import { ACTIVE_SET_CARDINALITY_FLOOR, COLLAPSE_DWELL_TURNS } from "./accordion-constants.js";
import {
  decideAutoCollapse,
  type BoxLike,
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

describe("active-tag-set auto-collapse", () => {
  it("collapses the stale box after a topic switch past the dwell", () => {
    const { turns, spans, boxes } = topicSwitch(2, COLLAPSE_DWELL_TURNS + 1);
    const collapsed = decideAutoCollapse({ turns, spans, boxes });
    expect(collapsed).toEqual(["box-voice"]); // voice fell out of the active set
  });

  it("does not collapse before the anti-thrash dwell elapses", () => {
    // Only a couple of coding turns: voice is stale but still within the dwell window.
    const { turns, spans, boxes } = topicSwitch(2, COLLAPSE_DWELL_TURNS - 1);
    expect(decideAutoCollapse({ turns, spans, boxes })).toEqual([]);
  });

  it("keeps the active topic's box live (high Jaccard overlap)", () => {
    const { turns, spans, boxes } = topicSwitch(2, COLLAPSE_DWELL_TURNS + 1);
    const collapsed = decideAutoCollapse({ turns, spans, boxes });
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
    expect(decideAutoCollapse({ turns, spans, boxes: [box("box-voice")] })).toEqual([]);
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
    const collapsed = decideAutoCollapse({
      turns,
      spans,
      boxes: [box("box-voice"), box("box-code")],
    });
    expect(collapsed).toEqual([]);
  });

  it("respects a manual-expand override via the last_active_seq head bump", () => {
    const { turns, spans } = topicSwitch(2, COLLAPSE_DWELL_TURNS + 1);
    const head = turns[turns.length - 1].seq;
    // Operator just expanded box-voice → last_active_seq bumped to the head; the dwell
    // now measures from the head, so it stays live until the topic genuinely moves on.
    const pinned = [box("box-voice", { last_active_seq: head }), box("box-code")];
    expect(decideAutoCollapse({ turns, spans, boxes: pinned })).toEqual([]);
  });

  it("ignores already-collapsed and topic-less boxes", () => {
    const { turns, spans } = topicSwitch(2, COLLAPSE_DWELL_TURNS + 1);
    const boxes = [box("box-voice", { state: "collapsed" }), box("box-empty")];
    expect(decideAutoCollapse({ turns, spans, boxes })).toEqual([]);
  });
});
