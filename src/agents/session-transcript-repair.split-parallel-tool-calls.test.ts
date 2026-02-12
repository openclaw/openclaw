import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { splitParallelToolCalls } from "./session-transcript-repair.js";

type Rec = Record<string, unknown>;
type RecArray = Rec[];

describe("splitParallelToolCalls", () => {
  it("returns same array when no assistant messages have multiple tool calls", () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "search", arguments: { q: "cats" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "search",
        content: [{ type: "text", text: "results" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = splitParallelToolCalls(input);
    expect(out).toBe(input); // same reference — no change
  });

  it("splits assistant with 2 parallel tool calls into 2 sequential pairs", () => {
    const input = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "search", arguments: { q: "a" } },
          { type: "toolCall", id: "call_2", name: "read", arguments: { file: "b" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "search",
        content: [{ type: "text", text: "result_a" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "read",
        content: [{ type: "text", text: "result_b" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = splitParallelToolCalls(input);
    expect(out).toHaveLength(5); // user + 2*(assistant+toolResult)

    expect(out[0]).toBe(input[0]); // user unchanged

    // First pair
    const a1 = out[1] as Extract<AgentMessage, { role: "assistant" }>;
    expect(a1.role).toBe("assistant");
    expect(a1.content).toHaveLength(1);
    expect((a1.content as RecArray)[0].id).toBe("call_1");

    expect((out[2] as Rec).role).toBe("toolResult");
    expect((out[2] as Rec).toolCallId).toBe("call_1");

    // Second pair
    const a2 = out[3] as Extract<AgentMessage, { role: "assistant" }>;
    expect(a2.role).toBe("assistant");
    expect(a2.content).toHaveLength(1);
    expect((a2.content as RecArray)[0].id).toBe("call_2");

    expect((out[4] as Rec).role).toBe("toolResult");
    expect((out[4] as Rec).toolCallId).toBe("call_2");
  });

  it("preserves non-tool-call content blocks on the first split assistant message", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me do both." },
          { type: "toolCall", id: "c1", name: "t1", arguments: {} },
          { type: "toolCall", id: "c2", name: "t2", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "t1",
        content: [{ type: "text", text: "r1" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "t2",
        content: [{ type: "text", text: "r2" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = splitParallelToolCalls(input);
    expect(out).toHaveLength(4); // 2 * (assistant + toolResult)

    const first = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(first.content).toHaveLength(2); // text block + 1 tool call
    expect((first.content as RecArray)[0].type).toBe("text");
    expect((first.content as RecArray)[0].text).toBe("Let me do both.");
    expect((first.content as RecArray)[1].id).toBe("c1");

    const second = out[2] as Extract<AgentMessage, { role: "assistant" }>;
    expect(second.content).toHaveLength(1); // just the tool call
    expect((second.content as RecArray)[0].id).toBe("c2");
  });

  it("splits 3 parallel tool calls into 3 sequential pairs", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "x", arguments: {} },
          { type: "toolCall", id: "b", name: "y", arguments: {} },
          { type: "toolCall", id: "c", name: "z", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "a",
        toolName: "x",
        content: [{ type: "text", text: "ra" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "b",
        toolName: "y",
        content: [{ type: "text", text: "rb" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "c",
        toolName: "z",
        content: [{ type: "text", text: "rc" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = splitParallelToolCalls(input);
    expect(out).toHaveLength(6); // 3 * (assistant + toolResult)

    for (let k = 0; k < 3; k++) {
      expect((out[k * 2] as Rec).role).toBe("assistant");
      expect((out[k * 2 + 1] as Rec).role).toBe("toolResult");
    }

    expect((out[1] as Rec).toolCallId).toBe("a");
    expect((out[3] as Rec).toolCallId).toBe("b");
    expect((out[5] as Rec).toolCallId).toBe("c");
  });

  it("handles mixed: some single, some parallel tool calls", () => {
    const input = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "solo", name: "one", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "solo",
        toolName: "one",
        content: [{ type: "text", text: "done" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "p1", name: "a", arguments: {} },
          { type: "toolCall", id: "p2", name: "b", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "p1",
        toolName: "a",
        content: [{ type: "text", text: "ra" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "p2",
        toolName: "b",
        content: [{ type: "text", text: "rb" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "all done" }] },
    ] satisfies AgentMessage[];

    const out = splitParallelToolCalls(input);
    // user(1) + single pair(2) + split pair(4) + final assistant(1) = 8
    expect(out).toHaveLength(8);

    // Single pair unchanged (same references)
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
    expect(out[2]).toBe(input[2]);

    // Split pair
    expect((out[3] as Rec).role).toBe("assistant");
    expect(((out[3] as Rec).content as RecArray).length).toBe(1);
    expect(((out[3] as Rec).content as RecArray)[0].id).toBe("p1");
    expect((out[4] as Rec).toolCallId).toBe("p1");
    expect(((out[5] as Rec).content as RecArray)[0].id).toBe("p2");
    expect((out[6] as Rec).toolCallId).toBe("p2");

    // Final assistant
    expect(out[7]).toBe(input[6]);
  });

  it("handles assistant with no content array (no-op)", () => {
    const input = [{ role: "assistant", content: "plain string" }] as unknown as AgentMessage[];

    const out = splitParallelToolCalls(input);
    expect(out).toBe(input);
  });
});
