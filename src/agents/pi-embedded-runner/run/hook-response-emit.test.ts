/**
 * Tests for hook-response-emit helper.
 *
 * Verifies:
 * - Text extraction from string and content-part-array messages
 * - Hook modification applied to assistantTexts and session messages
 * - Block results return undefined
 * - No-op when hook returns same content
 * - No-op when no assistant message found
 * - Hook errors propagate (caller catches)
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { HookRunner, PluginHookAgentContext } from "../../../plugins/hooks.js";
import { applyBeforeResponseEmitHook, extractAssistantText } from "./hook-response-emit.js";

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

    expect(result).toBe("modified!");
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

    expect(result).toBe("modified!");
    expect(
      ((sessionMsg as { content: unknown }).content as Array<{ type: string; text: string }>)[0]
        .text,
    ).toBe("modified!");
  });

  it("returns empty string when hook blocks", async () => {
    const hookRunner = makeMockHookRunner({ block: true, blockReason: "policy" });

    const result = await applyBeforeResponseEmitHook({
      hookRunner,
      agentCtx: dummyCtx,
      assistantTexts: ["original"],
      messagesSnapshot: [makeMsg("assistant", "original")],
      activeSession: { messages: [makeMsg("assistant", "original")] },
    });

    expect(result).toBe("");
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
});
