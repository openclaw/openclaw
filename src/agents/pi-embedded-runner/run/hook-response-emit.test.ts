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
  rewriteAllAssistantContent,
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

  it("clears current-run assistant content on block (multi-turn)", async () => {
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
      preRunMessageCount: 2, // 2 messages existed before run (prior history + new question)
    });

    // Prior history must be preserved
    expect((activeSession.messages[0] as { content: unknown }).content).toBe(
      "prior history - safe",
    );
    // Current-run assistant messages must be cleared
    expect((activeSession.messages[2] as { content: unknown }).content).toBe("");
    expect((activeSession.messages[4] as { content: unknown }).content).toBe("");
  });

  it("clears all text parts in multi-part messages on block", async () => {
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

    const parts = (sessionMsg as { content: unknown }).content as Array<{
      type: string;
      text: string;
    }>;
    expect(parts[0].text).toBe("");
    expect(parts[1].text).toBe("");
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
      preRunMessageCount: 2,
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
    const result = getRunScopedMessages(messages, 1, 1);
    expect(result).toHaveLength(1);
    expect((result[0] as { content: unknown }).content).toBe("new answer");
  });

  it("falls back to tail when compaction invalidates preRunMessageCount", () => {
    // Simulates compaction: preRunMessageCount was 50 but array is now 3
    const messages = [
      makeMsg("user", "compacted q"),
      makeMsg("assistant", "run turn 1"),
      makeMsg("assistant", "run turn 2"),
    ];
    const result = getRunScopedMessages(messages, 50, 2);
    expect(result).toHaveLength(2);
    expect((result[0] as { content: unknown }).content).toBe("run turn 1");
    expect((result[1] as { content: unknown }).content).toBe("run turn 2");
  });

  it("returns full array when no preRunMessageCount provided and enough assistants", () => {
    const messages = [makeMsg("assistant", "a"), makeMsg("assistant", "b")];
    const result = getRunScopedMessages(messages, undefined, 2);
    expect(result).toStrictEqual(messages);
  });

  it("returns empty when not enough assistant messages found (defensive)", () => {
    const messages = [makeMsg("user", "q")];
    const result = getRunScopedMessages(messages, 50, 2);
    expect(result).toHaveLength(0);
  });

  it("returns empty when assistantTextCount is 0", () => {
    const messages = [makeMsg("assistant", "a")];
    const result = getRunScopedMessages(messages, 50, 0);
    expect(result).toHaveLength(0);
  });
});
