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

// Partial mock — only runBeforeResponseEmit and hasHooks are exercised.
// Uses Partial<HookRunner> so new interface members cause compile errors
// only if they're called, not just declared. If a test needs another hook,
// add it explicitly rather than casting through unknown.
function makeMockHookRunner(emitResult?: {
  content?: string;
  allContent?: string[];
  block?: boolean;
  blockReason?: string;
}): HookRunner {
  const partial: Partial<HookRunner> = {
    hasHooks: vi.fn().mockReturnValue(true),
    runBeforeResponseEmit: vi.fn().mockResolvedValue(emitResult),
    getHookCount: vi.fn().mockReturnValue(0),
  };
  // Proxy returns vi.fn() for any unstubbed method so tests fail with a
  // clear "unexpected call" rather than "not a function" if new hooks are
  // invoked. This keeps the mock exhaustive-on-call without listing every
  // interface member.
  return new Proxy(partial as HookRunner, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      const stub = vi.fn();
      (target as Record<string | symbol, unknown>)[prop] = stub;
      return stub;
    },
  });
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

    expect(result).toMatchObject({ blocked: false, content: "modified!" });
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

    expect(result).toMatchObject({ blocked: false, content: "modified!" });
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

  it("removes current-run assistant messages on block (tool-loop multi-turn)", async () => {
    const hookRunner = makeMockHookRunner({ block: true, blockReason: "PII detected" });
    // Realistic tool-loop: user asks → assistant calls tool → toolResult → assistant answers
    // No user messages between assistant turns within a single prompt attempt.
    const activeSession = {
      messages: [
        makeMsg("assistant", "prior history - safe"),
        makeMsg("user", "new question"),
        makeMsg("assistant", "turn 1 with SSN 123-45-6789"),
        {
          role: "toolResult" as const,
          content: "tool output",
          timestamp: Date.now(),
        } as unknown as AgentMessage,
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

    // Prior history + user prompt preserved. Current-run assistant + toolResult removed.
    const assistantMsgs = activeSession.messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1); // only prior history remains
    expect((assistantMsgs[0] as { content: unknown }).content).toBe("prior history - safe");
    // toolResult also removed (would be orphaned)
    expect(activeSession.messages.filter((m) => m.role === "toolResult")).toHaveLength(0);
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

  it("removes orphaned toolResult messages alongside assistant on block", async () => {
    const hookRunner = makeMockHookRunner({ block: true, blockReason: "PII in tool args" });
    const activeSession = {
      messages: [
        makeMsg("assistant", "prior history"),
        makeMsg("user", "run a tool"),
        // tool-call assistant + toolResult + final answer — all in current run
        {
          role: "assistant" as const,
          content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "SSN" } }],
          timestamp: Date.now(),
        } as unknown as AgentMessage,
        {
          role: "toolResult" as const,
          content: "secret data",
          timestamp: Date.now(),
        } as unknown as AgentMessage,
        makeMsg("assistant", "Here is the SSN: 123-45-6789"),
      ],
    };

    await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["Here is the SSN: 123-45-6789"],
      messagesSnapshot: activeSession.messages.slice(),
      activeSession,
    });

    // Prior history + user message preserved; tool-call assistant, toolResult,
    // and final assistant all removed. No orphaned toolResult entries.
    expect(activeSession.messages).toHaveLength(2);
    expect(activeSession.messages[0].role).toBe("assistant");
    expect((activeSession.messages[0] as { content: unknown }).content).toBe("prior history");
    expect(activeSession.messages[1].role).toBe("user");
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

    expect(result).toMatchObject({ blocked: false, content: "modified" });
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

  it("passes allContent from session messages (per-turn, not per-chunk)", async () => {
    const hookRunner = makeMockHookRunner({ content: "modified" });
    // Tool-loop: 3 assistant turns in session
    const activeSession = {
      messages: [
        makeMsg("user", "question"),
        makeMsg("assistant", "turn 1"),
        {
          role: "toolResult" as const,
          content: "tool out",
          timestamp: Date.now(),
        } as unknown as AgentMessage,
        makeMsg("assistant", "turn 2"),
        {
          role: "toolResult" as const,
          content: "tool out",
          timestamp: Date.now(),
        } as unknown as AgentMessage,
        makeMsg("assistant", "turn 3"),
      ],
    };

    await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["turn 1", "turn 2", "turn 3"],
      messagesSnapshot: activeSession.messages.slice(),
      activeSession,
    });

    const callArgs = (hookRunner.runBeforeResponseEmit as ReturnType<typeof vi.fn>).mock.calls[0];
    // allContent is built from session messages, not raw assistantTexts.
    // This ensures per-turn content even in block-reply mode where
    // assistantTexts may have multiple chunks per turn.
    expect(callArgs[0].allContent).toEqual(["turn 1", "turn 2", "turn 3"]);
    expect(callArgs[0].content).toBe("turn 3");
  });

  it("applies allContent multi-turn modification scoped to current run", async () => {
    const hookRunner = makeMockHookRunner({
      allContent: ["[REDACTED turn 1]", "[REDACTED turn 2]"],
    });
    // Tool-loop: user → assistant (tool call + text) → toolResult → assistant (final)
    const activeSession = {
      messages: [
        makeMsg("assistant", "old safe history"),
        makeMsg("user", "new question"),
        makeMsg("assistant", "PII in turn 1"),
        {
          role: "toolResult" as const,
          content: "tool output",
          timestamp: Date.now(),
        } as unknown as AgentMessage,
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

    expect(result).toMatchObject({
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

  it("allContent: [] returns empty consolidatedTexts (does not leak prior history)", async () => {
    // When a plugin returns allContent: [] to remove all current-run turns,
    // consolidatedTexts must be empty — NOT populated from prior-history
    // assistant messages.
    const hookRunner = makeMockHookRunner({ allContent: [] });
    const activeSession = {
      messages: [
        makeMsg("assistant", "prior history answer"),
        makeMsg("user", "new question"),
        makeMsg("assistant", "current run answer"),
      ],
    };

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["current run answer"],
      messagesSnapshot: activeSession.messages.slice(),
      activeSession,
    });

    expect(result?.blocked).toBe(false);
    expect(result?.allContent).toEqual([]);
    expect(result?.consolidatedTexts).toEqual([]);
  });

  it("allContent shrink does not overshoot into prior history (no-user-boundary session)", async () => {
    // In sessions without a user boundary (e.g. sub-agent), after shrinking
    // allContent, the rescoped turn count must be capped to the original run's
    // scope — not pick up prior-history assistants.
    const hookRunner = makeMockHookRunner({ allContent: ["[REDACTED]"] });
    const activeSession = {
      messages: [
        // No user message anywhere — simulates greeting-first / sub-agent session
        makeMsg("assistant", "prior greeting"),
        makeMsg("assistant", "turn 1"),
        makeMsg("assistant", "turn 2"),
      ],
    };

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["turn 1", "turn 2"],
      messagesSnapshot: activeSession.messages.slice(),
      activeSession,
    });

    expect(result?.blocked).toBe(false);
    // consolidatedTexts should only contain the rewritten turn, NOT the prior greeting
    expect(result?.consolidatedTexts).toHaveLength(1);
    expect(result?.consolidatedTexts?.[0]).toBe("[REDACTED]");
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

    rewriteAllAssistantContent(messages, messages, ["new 1", "new 2", "new 3"]);

    expect((messages[0] as { content: unknown }).content).toBe("new 1");
    expect((messages[2] as { content: unknown }).content).toBe("new 2");
    expect((messages[4] as { content: unknown }).content).toBe("new 3");
    // Non-assistant messages untouched
    expect((messages[1] as { content: unknown }).content).toBe("question");
  });

  it("removes extra assistant messages when newContents is shorter", () => {
    const messages = [
      makeMsg("assistant", "turn 1"),
      makeMsg("assistant", "turn 2"),
      makeMsg("assistant", "turn 3"),
    ];

    rewriteAllAssistantContent(messages, messages, ["only first"]);

    // First message rewritten; extras removed entirely (not blanked to "")
    // to avoid empty-content messages that break Anthropic API.
    expect(messages).toHaveLength(1);
    expect((messages[0] as { content: unknown }).content).toBe("only first");
  });

  it("removes extras from source array, not just slice (splice-on-slice fix)", async () => {
    const hookRunner = makeMockHookRunner({ allContent: ["[REDACTED]"] });
    // Tool-loop: two assistant turns in one run (no user message between)
    const activeSession = {
      messages: [
        makeMsg("user", "question"),
        makeMsg("assistant", "PII turn 1"),
        {
          role: "toolResult" as const,
          content: "tool output",
          timestamp: Date.now(),
        } as unknown as AgentMessage,
        makeMsg("assistant", "PII turn 2"),
      ],
    };

    await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["PII turn 1", "PII turn 2"],
      messagesSnapshot: activeSession.messages.slice(),
      activeSession,
    });

    // First message rewritten, second removed from activeSession.messages (not just slice)
    const assistants = activeSession.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as { content: unknown }).content).toBe("[REDACTED]");
    // PII turn 2 must not survive in session history
    const allContent = activeSession.messages.map((m) => (m as { content?: unknown }).content);
    expect(allContent).not.toContain("PII turn 2");
  });

  it("preserves toolResult belonging to kept text+tool_use assistant on allContent shrink", () => {
    // Scenario: kept assistant has mixed text + tool_use content, followed by
    // its toolResult, then an extra text-only assistant to be removed.
    // The backward scan must NOT remove the toolResult that belongs to the
    // kept assistant — doing so orphans the tool_use and causes Anthropic API
    // rejection on subsequent turns.
    const keptAssistant = {
      role: "assistant" as const,
      content: [
        { type: "text", text: "thinking out loud" },
        { type: "tool_use", id: "tu_1", name: "search", input: {} },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    const toolResult = {
      role: "toolResult" as const,
      content: "search results",
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    const extraAssistant = makeMsg("assistant", "extra turn to remove");

    const messages = [makeMsg("user", "question"), keptAssistant, toolResult, extraAssistant];

    // Plugin returns allContent with only 1 entry (shrinks from 2)
    rewriteAllAssistantContent(messages, messages, ["[REDACTED]"]);

    // keptAssistant should be rewritten
    const parts = (keptAssistant as { content: unknown[] }).content as Array<{
      type: string;
      text?: string;
    }>;
    expect(parts.find((p) => p.type === "text")?.text).toBe("[REDACTED]");

    // toolResult must survive — it belongs to the kept assistant
    expect(messages).toContain(toolResult);

    // extraAssistant must be removed
    expect(messages).not.toContain(extraAssistant);
  });

  it("handles content-part arrays", () => {
    const messages = [
      makeMsg("assistant", [
        { type: "text", text: "old part 1" },
        { type: "text", text: "old part 2" },
      ]),
    ];

    rewriteAllAssistantContent(messages, messages, ["new content"]);

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
