// Seq-walk (02-02): collapsed boxes fold in place — summary once per box, markers on
// the rest, non-contiguous ranges still emit the summary exactly once, live boxes stay
// verbatim. Pure: data in, fold plan out (applied via accordion-blocks.applyFold).
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { applyFold } from "./accordion-blocks.js";
import { type AnchorBox, buildAccordionFoldPlan, FOLDED_MARKER } from "./accordion-seq-walk.js";

function user(ts: number, text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: ts } as AgentMessage;
}
function assistant(responseId: string, text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    responseId,
    usage: {} as never,
    stopReason: "stop",
    timestamp: 0,
  } as AgentMessage;
}

const collapsed = (boxId: string, summary: string | null): AnchorBox => ({
  boxId,
  state: "collapsed",
  summary,
});
const live = (boxId: string): AnchorBox => ({ boxId, state: "live", summary: null });

describe("accordion seq-walk", () => {
  it("is a no-op when no boxes are known", () => {
    const msgs = [user(1, "a"), assistant("r1", "b")];
    expect(buildAccordionFoldPlan(msgs, new Map()).size).toBe(0);
    expect(applyFold(msgs, buildAccordionFoldPlan(msgs, new Map()))).toEqual(msgs);
  });

  it("leaves a live box verbatim and folds a collapsed box (summary once)", () => {
    const msgs = [
      user(1, "voice q"),
      assistant("r1", "voice a"),
      user(2, "now coding"),
      assistant("r2", "coding a"),
    ];
    const anchorToBox = new Map<string, AnchorBox>([
      ["u:1", collapsed("box-voice", "Voice setup discussion")],
      ["a:r1", collapsed("box-voice", "Voice setup discussion")],
      ["u:2", live("box-code")],
      ["a:r2", live("box-code")],
    ]);
    const folded = applyFold(msgs, buildAccordionFoldPlan(msgs, anchorToBox));

    // collapsed box: first message carries the summary, the rest a marker
    expect((folded[0] as { content: { text: string }[] }).content[0]?.text).toBe(
      "Voice setup discussion",
    );
    expect((folded[1] as { content: { text: string }[] }).content[0]?.text).toBe(FOLDED_MARKER);
    // live box: untouched
    expect((folded[2] as { content: { text: string }[] }).content[0]?.text).toBe("now coding");
    expect((folded[3] as { content: { text: string }[] }).content[0]?.text).toBe("coding a");
    expect(folded).toHaveLength(4); // positions preserved
  });

  it("emits the summary exactly once across NON-CONTIGUOUS ranges of the same box", () => {
    // box-A owns turns 0,1 and 4,5; box-B (live) interleaves at 2,3
    const msgs = [
      user(1, "A start"),
      assistant("rA1", "A reply"),
      user(2, "B start"),
      assistant("rB1", "B reply"),
      user(3, "A resumes"),
      assistant("rA2", "A reply 2"),
    ];
    const A = collapsed("box-A", "Topic A summary");
    const anchorToBox = new Map<string, AnchorBox>([
      ["u:1", A],
      ["a:rA1", A],
      ["u:2", live("box-B")],
      ["a:rB1", live("box-B")],
      ["u:3", A],
      ["a:rA2", A],
    ]);
    const folded = applyFold(msgs, buildAccordionFoldPlan(msgs, anchorToBox));
    const text = (i: number) => (folded[i] as { content: { text: string }[] }).content[0]?.text;

    expect(text(0)).toBe("Topic A summary"); // summary emitted once, on first A turn
    expect(text(1)).toBe(FOLDED_MARKER);
    expect(text(2)).toBe("B start"); // live B untouched
    expect(text(3)).toBe("B reply");
    expect(text(4)).toBe(FOLDED_MARKER); // later non-contiguous A range: marker, NOT a 2nd summary
    expect(text(5)).toBe(FOLDED_MARKER);
  });

  it("folds assistant text/thinking but never a tool_call, keeping the result envelope", () => {
    const asst = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "calling tool" },
        { type: "toolCall", id: "c1", name: "read_file", arguments: {} },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      responseId: "rT",
      usage: {} as never,
      stopReason: "toolUse",
      timestamp: 0,
    } as AgentMessage;
    const tr = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read_file",
      content: [{ type: "text", text: "HUGE BODY" }],
      isError: false,
      timestamp: 5,
    } as AgentMessage;

    const box = collapsed("box-T", "Tool topic");
    const anchorToBox = new Map<string, AnchorBox>([
      ["a:rT", box],
      ["r:c1", box],
    ]);
    const folded = applyFold([asst, tr], buildAccordionFoldPlan([asst, tr], anchorToBox));

    const a = folded[0] as {
      content: { type: string; thinking?: string; text?: string; id?: string }[];
    };
    expect(a.content[0]).toEqual({ type: "thinking", thinking: "Tool topic" }); // first foldable part → summary
    expect(a.content[1]).toEqual({ type: "text", text: FOLDED_MARKER }); // second foldable part → marker
    expect(a.content[2]?.type).toBe("toolCall"); // tool_call untouched
    expect(a.content[2]?.id).toBe("c1");
    const result = folded[1] as {
      toolCallId: string;
      toolName: string;
      content: { text: string }[];
    };
    expect(result.toolCallId).toBe("c1"); // envelope intact → pair preserved
    expect(result.content[0]?.text).toBe(FOLDED_MARKER); // box's 2nd message → marker (summary already emitted)
  });
});
