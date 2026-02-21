import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { applyStartupPruning } from "./startup-pruning.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

const asAppendMessage = (message: unknown) => message as AppendMessage;

function makeUserMessage(id: number, size: number): AppendMessage {
  return asAppendMessage({
    role: "user",
    content: "x".repeat(size),
    timestamp: id,
  });
}

function makeAssistantMessage(id: number, size: number): AppendMessage {
  return asAppendMessage({
    role: "assistant",
    content: [{ type: "text", text: "y".repeat(size) }],
    timestamp: id,
  });
}

describe("applyStartupPruning", () => {
  it("returns false when pruning is disabled", async () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage(makeUserMessage(1, 1000));

    const result = await applyStartupPruning({
      sessionManager: sm,
      config: { enabled: false },
      provider: "anthropic",
      modelId: "claude-sonnet-4-0",
    });

    expect(result).toBe(false);
  });

  it("returns false when session is empty", async () => {
    const sm = SessionManager.inMemory();

    const result = await applyStartupPruning({
      sessionManager: sm,
      config: { enabled: true },
      provider: "anthropic",
      modelId: "claude-sonnet-4-0",
    });

    expect(result).toBe(false);
  });

  it("returns false when session is within target token limit", async () => {
    const sm = SessionManager.inMemory();
    // Add small messages that won't exceed target
    sm.appendMessage(makeUserMessage(1, 100));
    sm.appendMessage(makeAssistantMessage(2, 100));

    const result = await applyStartupPruning({
      sessionManager: sm,
      config: {
        enabled: true,
        targetTokens: 100000, // Large target, won't need pruning
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-0",
    });

    expect(result).toBe(false);
  });

  it("prunes session when token count exceeds target", async () => {
    const sm = SessionManager.inMemory();

    // Add many large messages to exceed target
    for (let i = 1; i <= 20; i++) {
      sm.appendMessage(makeUserMessage(i * 2 - 1, 10000));
      sm.appendMessage(makeAssistantMessage(i * 2, 10000));
    }

    const entriesBefore = sm.getEntries().length;
    expect(entriesBefore).toBe(40);

    // Mock the branching methods since inMemory doesn't support file operations
    const branchSpy = vi.spyOn(sm, "branch");
    const createBranchedSessionSpy = vi
      .spyOn(sm, "createBranchedSession")
      .mockReturnValue("/tmp/test-session-branched.jsonl");
    const setSessionFileSpy = vi.spyOn(sm, "setSessionFile").mockImplementation(() => {});

    const result = await applyStartupPruning({
      sessionManager: sm,
      config: {
        enabled: true,
        targetTokens: 5000, // Very small target to force pruning
        strategy: "keep-recent",
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-0",
    });

    expect(result).toBe(true);
    expect(branchSpy).toHaveBeenCalled();
    expect(createBranchedSessionSpy).toHaveBeenCalled();
    expect(setSessionFileSpy).toHaveBeenCalledWith("/tmp/test-session-branched.jsonl");
  });

  it("uses default 80% of context window when targetTokens not specified", async () => {
    const sm = SessionManager.inMemory();

    // Add messages
    for (let i = 1; i <= 5; i++) {
      sm.appendMessage(makeUserMessage(i * 2 - 1, 1000));
      sm.appendMessage(makeAssistantMessage(i * 2, 1000));
    }

    // With no targetTokens, should use 80% of context window
    // Context window for claude-sonnet-4-0 should be large enough that these messages fit
    const result = await applyStartupPruning({
      sessionManager: sm,
      config: { enabled: true },
      provider: "anthropic",
      modelId: "claude-sonnet-4-0",
    });

    // Small session should fit within 80% of context window
    expect(result).toBe(false);
  });

  it("warns about keep-summarized strategy but falls back to keep-recent", async () => {
    const sm = SessionManager.inMemory();

    for (let i = 1; i <= 20; i++) {
      sm.appendMessage(makeUserMessage(i * 2 - 1, 10000));
      sm.appendMessage(makeAssistantMessage(i * 2, 10000));
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(sm, "createBranchedSession").mockReturnValue("/tmp/test.jsonl");
    vi.spyOn(sm, "setSessionFile").mockImplementation(() => {});

    const result = await applyStartupPruning({
      sessionManager: sm,
      config: {
        enabled: true,
        targetTokens: 5000,
        strategy: "keep-summarized",
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-0",
    });

    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "[startup-pruning] keep-summarized not yet implemented, using keep-recent",
    );

    warnSpy.mockRestore();
  });

  it("returns false when createBranchedSession fails", async () => {
    const sm = SessionManager.inMemory();

    for (let i = 1; i <= 20; i++) {
      sm.appendMessage(makeUserMessage(i * 2 - 1, 10000));
      sm.appendMessage(makeAssistantMessage(i * 2, 10000));
    }

    vi.spyOn(sm, "createBranchedSession").mockReturnValue(undefined as unknown as string);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await applyStartupPruning({
      sessionManager: sm,
      config: {
        enabled: true,
        targetTokens: 5000,
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-0",
    });

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith("[startup-pruning] Failed to create branched session");

    warnSpy.mockRestore();
  });

  it("logs warning when keeping fewer messages than minRecentMessages", async () => {
    const sm = SessionManager.inMemory();

    // Add just a few large messages
    for (let i = 1; i <= 5; i++) {
      sm.appendMessage(makeUserMessage(i * 2 - 1, 50000));
      sm.appendMessage(makeAssistantMessage(i * 2, 50000));
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(sm, "createBranchedSession").mockReturnValue("/tmp/test.jsonl");
    vi.spyOn(sm, "setSessionFile").mockImplementation(() => {});

    await applyStartupPruning({
      sessionManager: sm,
      config: {
        enabled: true,
        targetTokens: 5000, // Very small, will keep only a few messages
        minRecentMessages: 20, // High minimum to trigger warning
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-0",
    });

    const minRecentWarning = warnSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Keeping only"),
    );
    expect(minRecentWarning).toBeDefined();

    warnSpy.mockRestore();
  });
});
