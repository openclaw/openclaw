// Spike (02-02-1): prove the ported Accordion block-id + kind-safe in-place fold
// works on OpenClaw's real AgentMessage shapes — durable ids derivable, tool pairs
// never orphaned, positions preserved.
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { applyFold, blockId, isDurableId } from "./accordion-blocks.js";

function sample(): AgentMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "set up voice" }], timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "long private reasoning ".repeat(50) },
        { type: "text", text: "I'll check the config." },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a" } },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude",
      responseId: "resp-1",
      usage: {} as never,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_file",
      content: [{ type: "text", text: "HUGE FILE BODY ".repeat(500) }],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 4 },
  ] as AgentMessage[];
}

describe("accordion-blocks (02-02 spike)", () => {
  it("derives durable content-anchored ids from OpenClaw message anchors", () => {
    const msgs = sample();
    expect(blockId(msgs[0]!, 0)).toBe("u:1");
    expect(blockId(msgs[1]!, 1, 0)).toBe("a:resp-1:p0"); // thinking part
    expect(blockId(msgs[1]!, 1, 2)).toBe("a:resp-1:p2"); // tool_call part
    expect(blockId(msgs[2]!, 2)).toBe("r:call-1");
    expect(["u:1", "a:resp-1:p0", "r:call-1"].every(isDurableId)).toBe(true);
  });

  it("falls back to a non-durable positional id when an anchor is missing", () => {
    const noAnchor = { role: "assistant", content: [{ type: "text", text: "x" }] } as AgentMessage;
    const id = blockId(noAnchor, 7, 0);
    expect(id).toBe("m7:p0");
    expect(isDurableId(id)).toBe(false);
  });

  it("folds the tool-result body but keeps the envelope (no orphaned pair)", () => {
    const msgs = sample();
    const folded = applyFold(msgs, new Map([["r:call-1", "[folded: read_file output]"]]));

    expect(folded).toHaveLength(msgs.length); // positions preserved
    const tr = folded[2] as {
      role: string;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      content: { type: string; text: string }[];
    };
    expect(tr.role).toBe("toolResult");
    expect(tr.toolCallId).toBe("call-1"); // envelope intact → pairs with the tool_call
    expect(tr.toolName).toBe("read_file");
    expect(tr.isError).toBe(false);
    expect(tr.content).toEqual([{ type: "text", text: "[folded: read_file output]" }]);

    // the tool_call part is untouched, so the call is still answered
    const asst = folded[1] as { content: { type: string; id?: string }[] };
    expect(asst.content[2]).toEqual({
      type: "toolCall",
      id: "call-1",
      name: "read_file",
      arguments: { path: "a" },
    });
  });

  it("folds an assistant thinking part to a digest and never folds a tool_call", () => {
    const msgs = sample();
    const folded = applyFold(
      msgs,
      new Map([
        ["a:resp-1:p0", "[folded reasoning]"],
        ["a:resp-1:p2", "ATTEMPT TO FOLD TOOLCALL"], // must be ignored
      ]),
    );
    const asst = folded[1] as { content: { type: string; thinking?: string; id?: string }[] };
    expect(asst.content[0]).toEqual({ type: "thinking", thinking: "[folded reasoning]" });
    expect(asst.content[2]?.type).toBe("toolCall"); // unchanged
    expect(asst.content[2]?.id).toBe("call-1");
  });

  it("is a no-op for an empty plan and preserves identity when nothing matches", () => {
    const msgs = sample();
    expect(applyFold(msgs, new Map())).toEqual(msgs);
    expect(applyFold(msgs, new Map([["r:does-not-exist", "x"]]))).toEqual(msgs);
  });
});
