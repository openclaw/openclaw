/**
 * Tests for hook-response-emit helper.
 *
 * Verifies:
 * - Text extraction from string and content-part-array messages
 * - Hook modification applied to assistantTexts and session messages
 * - Block results
 * - allContent multi-turn modification
 * - No-op when hook returns same content
 * - No-op when no assistant message found
 * - Hook errors propagate (caller catches)
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { HookRunner, PluginHookAgentContext } from "../../../plugins/hooks.js";
import {
  applyBeforeResponseEmitHook,
  extractAssistantText,
  getRunScopedMessages,
  getRunScopedMessagesForBlock,
  rewriteAllAssistantContent,
  rewriteLastAssistantContent,
} from "./hook-response-emit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(
  role: string,
  content: string | Array<{ type: string; text?: string }>,
): AgentMessage {
  return { role, content } as AgentMessage;
}

function makeMockHookRunner(emitResult?: {
  content?: string;
  allContent?: string[];
  block?: boolean;
  blockReason?: string;
}): HookRunner {
  return {
    hasHooks: vi.fn().mockReturnValue(true),
    runBeforeResponseEmit: vi.fn().mockResolvedValue(emitResult),
    // Stubs for other hooks (not used)
    runBeforeAgentStart: vi.fn(),
    runAgentEnd: vi.fn(),
    runBeforeCompaction: vi.fn(),
    runAfterCompaction: vi.fn(),
    runMessageReceived: vi.fn(),
    runMessageSending: vi.fn(),
    runMessageSent: vi.fn(),
    runBeforeToolCall: vi.fn(),
    runAfterToolCall: vi.fn(),
    runToolResultPersist: vi.fn(),
    runSessionStart: vi.fn(),
    runSessionEnd: vi.fn(),
    runGatewayStart: vi.fn(),
    runGatewayStop: vi.fn(),
    runBeforeLlmCall: vi.fn(),
    runAfterLlmCall: vi.fn(),
    runContextAssembled: vi.fn(),
    runLoopIterationStart: vi.fn(),
    runLoopIterationEnd: vi.fn(),
    getHookCount: vi.fn().mockReturnValue(0),
  } as unknown as HookRunner;
}

const dummyCtx: PluginHookAgentContext = {
  agentId: "test-agent",
  sessionKey: "test-session",
};

// ---------------------------------------------------------------------------
// extractAssistantText
// ---------------------------------------------------------------------------

describe("extractAssistantText", () => {
  it("extracts from string content", () => {
    expect(extractAssistantText(makeMsg("assistant", "hello world"))).toBe("hello world");
  });

  it("extracts from content-part array", () => {
    const msg = makeMsg("assistant", [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(extractAssistantText(msg)).toBe("hello world");
  });

  it("filters non-text parts", () => {
    const msg = makeMsg("assistant", [
      { type: "text", text: "hello" },
      { type: "tool_use" },
      { type: "text", text: " world" },
    ]);
    expect(extractAssistantText(msg)).toBe("hello world");
  });

  it("returns empty string for non-string non-array content", () => {
    const msg = { role: "assistant", content: 42 } as unknown as AgentMessage;
    expect(extractAssistantText(msg)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// applyBeforeResponseEmitHook
// ---------------------------------------------------------------------------

describe("applyBeforeResponseEmitHook", () => {
  it("returns modified content when hook changes it", async () => {
    const hookRunner = makeMockHookRunner({ content: "modified!" });
    const activeSession = { messages: [makeMsg("assistant", "original")] };

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["original"],
      messagesSnapshot: [makeMsg("assistant", "original")],
      activeSession,
      channel: "discord",
    });

    expect(result).toEqual({ blocked: false, content: "modified!" });
    // Session message should also be updated
    expect((activeSession.messages[0] as { content: unknown }).content).toBe("modified!");
  });

  it("updates content-part-array session messages", async () => {
    const hookRunner = makeMockHookRunner({ content: "modified!" });
    const sessionMsg = makeMsg("assistant", [{ type: "text", text: "original" }]);
    const activeSession = { messages: [sessionMsg] };

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["original"],
      messagesSnapshot: [makeMsg("assistant", [{ type: "text", text: "original" }])],
      activeSession,
      channel: "discord",
    });

    expect(result).toEqual({ blocked: false, content: "modified!" });
    expect(
      ((sessionMsg as { content: unknown }).content as Array<{ type: string; text: string }>)[0]
        .text,
    ).toBe("modified!");
  });

  it("returns blocked result when hook blocks", async () => {
    const hookRunner = makeMockHookRunner({ block: true, blockReason: "policy" });

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["original"],
      messagesSnapshot: [makeMsg("assistant", "original")],
      activeSession: { messages: [makeMsg("assistant", "original")] },
    });

    expect(result).toEqual({ blocked: true });
  });

  it("returns undefined when content unchanged", async () => {
    const hookRunner = makeMockHookRunner({ content: "original" });

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["original"],
      messagesSnapshot: [makeMsg("assistant", "original")],
      activeSession: { messages: [makeMsg("assistant", "original")] },
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when no assistant message", async () => {
    const hookRunner = makeMockHookRunner({ content: "modified" });

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: [],
      messagesSnapshot: [makeMsg("user", "hello")],
      activeSession: { messages: [makeMsg("user", "hello")] },
    });

    expect(result).toBeUndefined();
    expect(hookRunner.runBeforeResponseEmit).not.toHaveBeenCalled();
  });

  it("returns undefined when hook returns no result", async () => {
    const hookRunner = makeMockHookRunner(undefined);

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["original"],
      messagesSnapshot: [makeMsg("assistant", "original")],
      activeSession: { messages: [makeMsg("assistant", "original")] },
    });

    expect(result).toBeUndefined();
  });

  it("removes current-run assistant messages on block (multi-turn)", async () => {
    const hookRunner = makeMockHookRunner({ block: true, blockReason: "PII detected" });
    const activeSession = {
      messages: [
        makeMsg("assistant", "prior history - safe"),
        makeMsg("user", "new question"),
        makeMsg("assistant", "turn 1 with SSN 123-45-6789"),
        makeMsg("user", "continue"),
        makeMsg("assistant", "turn 2 with SSN 123-45-6789"),
      ],
    };

    await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["turn 1 with SSN 123-45-6789", "turn 2 with SSN 123-45-6789"],
      messagesSnapshot: activeSession.messages.slice(),
      activeSession,
    });

    // Prior history must be preserved
    expect((activeSession.messages[0] as { content: unknown }).content).toBe(
      "prior history - safe",
    );
    // Current-run assistant messages are removed entirely (not blanked).
    // Empty-content ghost messages would break LLM API calls (Anthropic rejects
    // { role: "assistant", content: [] }) so we splice them out.
    const assistantMsgs = activeSession.messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1); // only prior history remains
    expect((assistantMsgs[0] as { content: unknown }).content).toBe("prior history - safe");
  });

  it("removes multi-part assistant messages on block", async () => {
    const hookRunner = makeMockHookRunner({ block: true });
    const sessionMsg = makeMsg("assistant", [
      { type: "text", text: "part 1 with PII" },
      { type: "text", text: "part 2 with PII" },
    ]);
    const activeSession = { messages: [sessionMsg] };

    await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["part 1 with PII"],
      messagesSnapshot: [
        makeMsg("assistant", [
          { type: "text", text: "part 1 with PII" },
          { type: "text", text: "part 2 with PII" },
        ]),
      ],
      activeSession,
    });

    // Block removes assistant messages entirely — no ghost entries left
    expect(activeSession.messages).toHaveLength(0);
  });

  it("rewrites all text parts on modification (not just first)", async () => {
    const hookRunner = makeMockHookRunner({ content: "redacted" });
    const sessionMsg = makeMsg("assistant", [
      { type: "text", text: "sensitive part 1" },
      { type: "text", text: "sensitive part 2" },
    ]);
    const activeSession = { messages: [sessionMsg] };

    await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["sensitive part 1sensitive part 2"],
      messagesSnapshot: [
        makeMsg("assistant", [
          { type: "text", text: "sensitive part 1" },
          { type: "text", text: "sensitive part 2" },
        ]),
      ],
      activeSession,
    });

    const parts = (sessionMsg as { content: unknown }).content as Array<{
      type: string;
      text: string;
    }>;
    expect(parts[0].text).toBe("redacted");
    // Subsequent text parts should be cleared
    expect(parts[1].text).toBe("");
  });

  it("finds assistant message even when not the last element", async () => {
    const hookRunner = makeMockHookRunner({ content: "modified" });
    const assistantMsg = makeMsg("assistant", "original");
    const toolResult = makeMsg("tool", "result");
    const activeSession = { messages: [assistantMsg, toolResult] };

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["original"],
      messagesSnapshot: [makeMsg("assistant", "original"), makeMsg("tool", "result")],
      activeSession,
    });

    expect(result).toEqual({ blocked: false, content: "modified" });
    expect((assistantMsg as { content: unknown }).content).toBe("modified");
  });

  it("propagates hook errors to caller", async () => {
    const hookRunner = makeMockHookRunner(undefined);
    (hookRunner.runBeforeResponseEmit as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("hook crashed"),
    );

    await expect(
      applyBeforeResponseEmitHook({
        hookRunner,
        agentCtx: dummyCtx,
        assistantTexts: ["original"],
        messagesSnapshot: [makeMsg("assistant", "original")],
        activeSession: { messages: [makeMsg("assistant", "original")] },
      }),
    ).rejects.toThrow("hook crashed");
  });

  it("passes allContent to hook event", async () => {
    const hookRunner = makeMockHookRunner({ content: "modified" });

    await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["turn 1", "turn 2", "turn 3"],
      messagesSnapshot: [makeMsg("assistant", "turn 3")],
      activeSession: { messages: [makeMsg("assistant", "turn 3")] },
    });

    const callArgs = (hookRunner.runBeforeResponseEmit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0].allContent).toEqual(["turn 1", "turn 2", "turn 3"]);
    expect(callArgs[0].content).toBe("turn 3");
  });

  it("applies allContent multi-turn modification scoped to current run", async () => {
    const hookRunner = makeMockHookRunner({
      allContent: ["[REDACTED turn 1]", "[REDACTED turn 2]"],
    });
    const activeSession = {
      messages: [
        makeMsg("assistant", "old safe history"),
        makeMsg("user", "new question"),
        makeMsg("assistant", "PII in turn 1"),
        makeMsg("user", "continue"),
        makeMsg("assistant", "PII in turn 2"),
      ],
    };

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["PII in turn 1", "PII in turn 2"],
      messagesSnapshot: activeSession.messages.slice(),
      activeSession,
    });

    expect(result).toEqual({
      blocked: false,
      allContent: ["[REDACTED turn 1]", "[REDACTED turn 2]"],
    });
    // Prior history preserved
    expect((activeSession.messages[0] as { content: unknown }).content).toBe("old safe history");
    // Current-run assistant messages rewritten
    expect((activeSession.messages[2] as { content: unknown }).content).toBe("[REDACTED turn 1]");
    expect((activeSession.messages[4] as { content: unknown }).content).toBe("[REDACTED turn 2]");
  });

  it("allContent takes precedence over content", async () => {
    const hookRunner = makeMockHookRunner({
      content: "single-message mod",
      allContent: ["full turn 1", "full turn 2"],
    });
    const activeSession = {
      messages: [
        makeMsg("assistant", "original 1"),
        makeMsg("user", "continue"),
        makeMsg("assistant", "original 2"),
      ],
    };

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["original 1", "original 2"],
      messagesSnapshot: activeSession.messages.slice(),
      activeSession,
    });

    // allContent should win
    expect(result?.allContent).toEqual(["full turn 1", "full turn 2"]);
    expect(result?.content).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rewriteAllAssistantContent
// ---------------------------------------------------------------------------

describe("rewriteAllAssistantContent", () => {
  it("rewrites all assistant messages in order", () => {
    const messages = [
      makeMsg("assistant", "turn 1"),
      makeMsg("user", "question"),
      makeMsg("assistant", "turn 2"),
      makeMsg("tool", "result"),
      makeMsg("assistant", "turn 3"),
    ];

    rewriteAllAssistantContent(messages, ["new 1", "new 2", "new 3"]);

    expect((messages[0] as { content: unknown }).content).toBe("new 1");
    expect((messages[2] as { content: unknown }).content).toBe("new 2");
    expect((messages[4] as { content: unknown }).content).toBe("new 3");
    // Non-assistant messages untouched
    expect((messages[1] as { content: unknown }).content).toBe("question");
  });

  it("clears extra assistant messages when newContents is shorter", () => {
    const messages = [
      makeMsg("assistant", "turn 1"),
      makeMsg("assistant", "turn 2"),
      makeMsg("assistant", "turn 3"),
    ];

    rewriteAllAssistantContent(messages, ["only first"]);

    expect((messages[0] as { content: unknown }).content).toBe("only first");
    expect((messages[1] as { content: unknown }).content).toBe("");
    expect((messages[2] as { content: unknown }).content).toBe("");
  });

  it("handles content-part arrays", () => {
    const messages = [
      makeMsg("assistant", [
        { type: "text", text: "old part 1" },
        { type: "text", text: "old part 2" },
      ]),
    ];

    rewriteAllAssistantContent(messages, ["new content"]);

    const parts = (messages[0] as { content: unknown }).content as Array<{
      type: string;
      text: string;
    }>;
    expect(parts[0].text).toBe("new content");
    expect(parts[1].text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getRunScopedMessages
// ---------------------------------------------------------------------------

describe("getRunScopedMessages", () => {
  it("uses tail scan to find run-scoped messages (compaction-safe)", () => {
    const messages = [
      makeMsg("assistant", "old"),
      makeMsg("user", "new q"),
      makeMsg("assistant", "new answer"),
    ];
    // Tail scan finds 1 assistant message from end, returns from that point
    const result = getRunScopedMessages(messages, 1);
    expect(result).toHaveLength(1);
    expect((result[0] as { content: unknown }).content).toBe("new answer");
  });

  it("handles compacted transcript correctly via tail scan", () => {
    const messages = [
      makeMsg("user", "compacted q"),
      makeMsg("assistant", "run turn 1"),
      makeMsg("assistant", "run turn 2"),
    ];
    const result = getRunScopedMessages(messages, 2);
    expect(result).toHaveLength(2);
    expect((result[0] as { content: unknown }).content).toBe("run turn 1");
    expect((result[1] as { content: unknown }).content).toBe("run turn 2");
  });

  it("returns full array when all messages are from current run", () => {
    const messages = [makeMsg("assistant", "a"), makeMsg("assistant", "b")];
    const result = getRunScopedMessages(messages, 2);
    expect(result).toStrictEqual(messages);
  });

  it("returns empty when not enough assistant messages found (defensive)", () => {
    const messages = [makeMsg("user", "q")];
    const result = getRunScopedMessages(messages, 2);
    expect(result).toHaveLength(0);
  });

  it("returns empty when assistantTextCount is 0", () => {
    const messages = [makeMsg("assistant", "a")];
    const result = getRunScopedMessages(messages, 0);
    expect(result).toHaveLength(0);
  });
});

describe("rewriteLastAssistantContent", () => {
  it("skips tool-use-only messages and rewrites the last text-bearing one", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "I'll look that up" }],
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc1", name: "search", input: {} }],
      } as unknown as AgentMessage,
    ];
    rewriteLastAssistantContent(messages, "REDACTED");
    // The first message (text-bearing) should be rewritten
    expect(
      (messages[0] as unknown as { content: { type?: string; text?: string }[] }).content[0].text,
    ).toBe("REDACTED");
    // The second message (tool-use-only) should be untouched
    expect(
      (messages[1] as unknown as { content: { type?: string; text?: string }[] }).content[0].type,
    ).toBe("tool_use");
  });

  it("does not silently no-op on tool-use-only last message", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc1", name: "exec", input: {} }],
      } as unknown as AgentMessage,
    ];
    // No text-bearing message exists — should warn but not crash
    rewriteLastAssistantContent(messages, "REDACTED");
    // Tool-use message should be untouched
    expect(
      (messages[0] as unknown as { content: { type?: string; text?: string }[] }).content[0].type,
    ).toBe("tool_use");
  });
});

describe("getRunScopedMessagesForBlock", () => {
  const makeMsg = (role: string, content: string): AgentMessage =>
    ({ role, content: [{ type: "text", text: content }] }) as unknown as AgentMessage;
  const makeToolCallMsg = (): AgentMessage =>
    ({
      role: "assistant",
      content: [{ type: "tool_use", id: "tc1", name: "exec", input: {} }],
    }) as unknown as AgentMessage;
  const makeToolResult = (): AgentMessage =>
    ({ role: "toolResult", content: "result" }) as unknown as AgentMessage;

  it("includes tool-call-only assistant messages before text-bearing ones", () => {
    const messages = [
      makeMsg("user", "hello"), // run boundary
      makeToolCallMsg(), // tool-call-only assistant
      makeToolResult(), // tool result
      makeMsg("assistant", "answer"), // text-bearing assistant
    ];
    const result = getRunScopedMessagesForBlock(messages, 1);
    // Should include all 3 run messages (tool-call assistant, tool result, text assistant)
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("assistant"); // tool-call-only
    expect(result[2].role).toBe("assistant"); // text-bearing
  });

  it("stops at user message boundary", () => {
    const messages = [
      makeMsg("assistant", "prior"), // prior history
      makeMsg("user", "question"), // run boundary
      makeToolCallMsg(), // current run
      makeMsg("assistant", "answer"), // current run
    ];
    const result = getRunScopedMessagesForBlock(messages, 1);
    expect(result).toHaveLength(2); // tool-call + text assistant
    expect(result[0].role).toBe("assistant");
  });

  it("stops at prior text-bearing assistant (no user boundary)", () => {
    // Sub-agent or greeting session: no user message between turns.
    // Prior assistant text should NOT be included in block scope.
    const messages = [
      makeMsg("assistant", "prior greeting"), // prior turn — should NOT be included
      makeToolCallMsg(), // current run tool-call
      makeToolResult(), // current run tool result
      makeMsg("assistant", "current answer"), // current run text
    ];
    const result = getRunScopedMessagesForBlock(messages, 1);
    // Should include tool-call + tool-result + text assistant (3), NOT prior greeting
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("assistant"); // tool-call-only
    expect(result[2].role).toBe("assistant"); // text-bearing
  });
});
