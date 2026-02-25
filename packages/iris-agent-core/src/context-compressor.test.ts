/**
 * Unit tests for age-based tool result compression.
 */
import { EventStream } from "@mariozechner/pi-ai";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop } from "./agent-loop.js";
import { compressAgedToolResults } from "./context-compressor.js";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "./types.js";

// ─── agentLoop default-on helpers ─────────────────────────────────────────────

function mockDoneStreamFn() {
  const doneMsg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
  return async (_model: Model<string>, _ctx: unknown, _opts: unknown) => {
    const stream = new EventStream<{ type: string; partial: AssistantMessage }, AssistantMessage>(
      (e) => e.type === "done",
      () => doneMsg,
    );
    stream.push({ type: "done", partial: doneMsg });
    stream.end(doneMsg);
    return stream as ReturnType<typeof import("@mariozechner/pi-ai").streamSimple>;
  };
}

/** Build a context with N user-turns and a long tool result in the first turn. */
function makeCtxWithOldToolResult(longText: string, totalUserTurns: number): AgentContext {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < totalUserTurns; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `t${i}` }], timestamp: i });
    if (i === 0) {
      messages.push({
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        content: [{ type: "text", text: longText }],
        isError: false,
        timestamp: i + 0.5,
      } as AgentMessage);
    }
  }
  return { systemPrompt: "test", tools: [], messages };
}

async function runWithCapture(
  ctx: AgentContext,
  cfg: AgentLoopConfig,
  streamFn: ReturnType<typeof mockDoneStreamFn>,
): Promise<AgentMessage[]> {
  let captured: AgentMessage[] = [];
  const wrappedCfg: AgentLoopConfig = {
    ...cfg,
    convertToLlm: (msgs) => {
      captured = msgs;
      return msgs;
    },
  };
  const loop = agentLoop(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 999 }],
    ctx,
    wrappedCfg,
    undefined,
    streamFn,
  );
  for await (const _e of loop) {
    /* drain */
  }
  return captured;
}

// ─── agentLoop default-on tests ───────────────────────────────────────────────

describe("agentLoop default compression", () => {
  it("compresses old tool results by default (no toolResultCompression option set)", async () => {
    const longText = "z".repeat(500);
    const streamFn = mockDoneStreamFn();
    const cfg: AgentLoopConfig = {
      model: { provider: "anthropic", id: "claude-3-5-haiku-20241022" } as Model<string>,
      convertToLlm: (msgs) => msgs, // overridden by runWithCapture
      apiKey: "test-key",
      // toolResultCompression omitted → defaults apply
    };
    const ctx = makeCtxWithOldToolResult(longText, 4); // 4 turns → first is old

    const captured = await runWithCapture(ctx, cfg, streamFn);

    const tr = captured.find((m) => (m as { role?: string }).role === "toolResult") as
      | { content: { text: string }[] }
      | undefined;
    expect(tr).toBeDefined();
    expect(tr!.content[0]?.text.length).toBeLessThan(longText.length);
    expect(tr!.content[0]?.text).toContain("aged-out");
  });

  it("skips compression when toolResultCompression is false", async () => {
    const longText = "z".repeat(500);
    const streamFn = mockDoneStreamFn();
    const cfg: AgentLoopConfig = {
      model: { provider: "anthropic", id: "claude-3-5-haiku-20241022" } as Model<string>,
      convertToLlm: (msgs) => msgs,
      apiKey: "test-key",
      toolResultCompression: false,
    };
    const ctx = makeCtxWithOldToolResult(longText, 4);

    const captured = await runWithCapture(ctx, cfg, streamFn);

    const tr = captured.find((m) => (m as { role?: string }).role === "toolResult") as
      | { content: { text: string }[] }
      | undefined;
    expect(tr).toBeDefined();
    expect(tr!.content[0]?.text).toBe(longText); // unchanged
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function userMsg(text = "hi"): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMsg(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    timestamp: Date.now(),
  } as AgentMessage;
}

function toolResult(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "read_file",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("compressAgedToolResults", () => {
  it("does nothing when there are fewer turns than ageTurns", () => {
    const longText = "x".repeat(1000);
    const msgs: AgentMessage[] = [userMsg(), assistantMsg(), toolResult(longText)];
    // ageTurns=3, only 1 user message → nothing to compress
    const result = compressAgedToolResults(msgs, { ageTurns: 3, maxChars: 200 });
    expect(result).toHaveLength(3);
    const tr = result[2] as { content: { text: string }[] };
    expect(tr.content[0]?.text).toBe(longText);
  });

  it("does not compress tool results in recent turns", () => {
    const longText = "y".repeat(500);
    // 3 turns, ageTurns=3 → all protected
    const msgs: AgentMessage[] = [
      userMsg("t1"),
      assistantMsg(),
      toolResult(longText),
      userMsg("t2"),
      assistantMsg(),
      toolResult(longText),
      userMsg("t3"),
      assistantMsg(),
      toolResult(longText),
    ];
    const result = compressAgedToolResults(msgs, { ageTurns: 3, maxChars: 200 });
    // All 3 ToolResults should be unchanged
    for (const idx of [2, 5, 8]) {
      const tr = result[idx] as { content: { text: string }[] };
      expect(tr.content[0]?.text).toBe(longText);
    }
  });

  it("compresses tool results in turns older than ageTurns", () => {
    const longText = "z".repeat(500);
    // 4 turns, ageTurns=2 → turns 1 and 2 are old, turns 3 and 4 are recent
    const msgs: AgentMessage[] = [
      userMsg("t1"), // index 0 — old
      assistantMsg(), // index 1
      toolResult(longText), // index 2 — should compress
      userMsg("t2"), // index 3 — old
      assistantMsg(), // index 4
      toolResult(longText), // index 5 — should compress
      userMsg("t3"), // index 6 — recent (protected)
      assistantMsg(), // index 7
      toolResult(longText), // index 8 — recent
      userMsg("t4"), // index 9 — recent
      assistantMsg(), // index 10
      toolResult(longText), // index 11 — recent
    ];
    const result = compressAgedToolResults(msgs, { ageTurns: 2, maxChars: 100 });

    // Old tool results at index 2 and 5 should be compressed
    for (const idx of [2, 5]) {
      const tr = result[idx] as { content: { text: string }[] };
      const text = tr.content[0]?.text ?? "";
      expect(text.length).toBeLessThan(longText.length);
      expect(text).toContain("aged-out");
    }

    // Recent tool results at index 8 and 11 should be unchanged
    for (const idx of [8, 11]) {
      const tr = result[idx] as { content: { text: string }[] };
      expect(tr.content[0]?.text).toBe(longText);
    }
  });

  it("leaves short tool results unchanged even when old", () => {
    const shortText = "short";
    const msgs: AgentMessage[] = [
      userMsg("t1"),
      assistantMsg(),
      toolResult(shortText), // old but short — should not compress
      userMsg("t2"),
      assistantMsg(),
      toolResult("x".repeat(500)), // recent
      userMsg("t3"),
      assistantMsg(),
      toolResult("x".repeat(500)), // recent
      userMsg("t4"),
      assistantMsg(),
    ];
    const result = compressAgedToolResults(msgs, { ageTurns: 3, maxChars: 200 });
    const tr = result[2] as { content: { text: string }[] };
    expect(tr.content[0]?.text).toBe(shortText);
  });

  it("does not mutate the original messages array", () => {
    const longText = "m".repeat(500);
    const msgs: AgentMessage[] = [
      userMsg("t1"),
      assistantMsg(),
      toolResult(longText),
      userMsg("t2"),
      assistantMsg(),
      userMsg("t3"),
      assistantMsg(),
      userMsg("t4"),
      assistantMsg(),
    ];
    const original = msgs.map((m) => JSON.parse(JSON.stringify(m)));
    compressAgedToolResults(msgs, { ageTurns: 3, maxChars: 50 });
    expect(JSON.stringify(msgs)).toBe(JSON.stringify(original));
  });
});

// ─── Stage 2: assistant message compression ───────────────────────────────────

function assistantWithText(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    timestamp: Date.now(),
  } as AgentMessage;
}

function assistantWithThinkingAndText(thinking: string, text: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
    stopReason: "end_turn",
    timestamp: Date.now(),
  } as AgentMessage;
}

function assistantWithToolCall(text: string, toolCallId: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", id: toolCallId, name: "read", arguments: {} },
    ],
    stopReason: "tool_use",
    timestamp: Date.now(),
  } as AgentMessage;
}

describe("Stage 2: assistant message compression", () => {
  /** Build N-turn context with a long assistant reply in turn 1. */
  function makeMsgs(longText: string, totalTurns: number): AgentMessage[] {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < totalTurns; i++) {
      msgs.push(userMsg(`t${i}`));
      msgs.push(i === 0 ? assistantWithText(longText) : assistantMsg());
    }
    return msgs;
  }

  it("truncates long assistant text in old turns", () => {
    const longText = "a".repeat(1000);
    const msgs = makeMsgs(longText, 4); // 4 turns, ageTurns=2 → turns 1-2 are old
    const result = compressAgedToolResults(msgs, {
      ageTurns: 2,
      maxChars: 200,
      maxAssistantChars: 100,
    });
    const am = result[1] as { content: { text: string }[] };
    expect(am.content[0]?.text.length).toBeLessThan(longText.length);
    expect(am.content[0]?.text).toContain("aged-out");
  });

  it("leaves short assistant text unchanged even when old", () => {
    const shortText = "hello";
    const msgs = makeMsgs(shortText, 4);
    const result = compressAgedToolResults(msgs, {
      ageTurns: 2,
      maxChars: 200,
      maxAssistantChars: 100,
    });
    const am = result[1] as { content: { text: string }[] };
    expect(am.content[0]?.text).toBe(shortText);
  });

  it("drops thinking blocks from old assistant messages", () => {
    const msgs: AgentMessage[] = [
      userMsg("t1"),
      assistantWithThinkingAndText("long thinking...", "short reply"),
      userMsg("t2"),
      assistantMsg(),
      userMsg("t3"),
      assistantMsg(),
    ];
    const result = compressAgedToolResults(msgs, {
      ageTurns: 2,
      maxChars: 200,
      maxAssistantChars: 500,
    });
    const am = result[1] as { content: unknown[] };
    const hasThinking = am.content.some((b) => (b as { type?: string }).type === "thinking");
    expect(hasThinking).toBe(false);
    expect(am.content.some((b) => (b as { type?: string }).type === "text")).toBe(true);
  });

  it("preserves tool call blocks in old assistant messages", () => {
    const msgs: AgentMessage[] = [
      userMsg("t1"),
      assistantWithToolCall("a".repeat(1000), "tc-old"),
      userMsg("t2"),
      assistantMsg(),
      userMsg("t3"),
      assistantMsg(),
    ];
    const result = compressAgedToolResults(msgs, {
      ageTurns: 2,
      maxChars: 200,
      maxAssistantChars: 100,
    });
    const am = result[1] as { content: unknown[] };
    const hasToolCall = am.content.some((b) => (b as { type?: string }).type === "toolCall");
    expect(hasToolCall).toBe(true);
  });

  it("does not compress assistant text when maxAssistantChars is 0", () => {
    const longText = "b".repeat(1000);
    const msgs = makeMsgs(longText, 4);
    const result = compressAgedToolResults(msgs, {
      ageTurns: 2,
      maxChars: 200,
      maxAssistantChars: 0,
    });
    const am = result[1] as { content: { text: string }[] };
    expect(am.content[0]?.text).toBe(longText);
  });
});
