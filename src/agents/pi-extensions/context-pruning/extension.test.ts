import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextPruningRuntimeValue } from "./runtime.js";
import type { EffectiveContextPruningSettings } from "./settings.js";
import { CHARS_PER_TOKEN_ESTIMATE, estimateContextChars } from "./pruner.js";
import { setContextPruningRuntime, getContextPruningRuntime } from "./runtime.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock updateSessionStoreEntry so the extension can import it without
// touching the real filesystem.
const mockUpdateSessionStoreEntry = vi.fn().mockResolvedValue(null);
vi.mock("../../../config/sessions.js", () => ({
  updateSessionStoreEntry: (...args: unknown[]) => mockUpdateSessionStoreEntry(...args),
}));

// Mock pruneContextMessages to control pruning behavior
const mockPruneContextMessages = vi.fn();
vi.mock("./pruner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pruner.js")>();
  return {
    ...original,
    pruneContextMessages: (...args: unknown[]) => mockPruneContextMessages(...args),
  };
});

// Dynamic import so mocks are in place first
const { default: contextPruningExtension } = await import("./extension.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings(
  overrides?: Partial<EffectiveContextPruningSettings>,
): EffectiveContextPruningSettings {
  return {
    mode: "cache-ttl",
    ttlMs: 300_000,
    softTrimRatio: 0.7,
    hardClearRatio: 0.9,
    keepLastAssistants: 3,
    minPrunableToolChars: 0,
    softTrim: { maxChars: 4000, headChars: 500, tailChars: 500 },
    hardClear: { enabled: true, placeholder: "[pruned]" },
    tools: { prunable: [], protected: [] },
    ...overrides,
  };
}

function makeSessionManager(): object {
  return {};
}

function makeMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: "user" as const,
    content: `message ${i} ${"x".repeat(100)}`,
  }));
}

function makePrunedMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: "user" as const,
    content: `pruned ${i}`,
  }));
}

function buildExtensionAndCapture(): {
  handler: (event: ContextEvent, ctx: ExtensionContext) => unknown;
} {
  let captured: ((event: ContextEvent, ctx: ExtensionContext) => unknown) | null = null;
  const api: ExtensionAPI = {
    on: (eventName: string, handler: unknown) => {
      if (eventName === "context") {
        captured = handler as typeof captured;
      }
    },
  } as unknown as ExtensionAPI;

  contextPruningExtension(api);
  if (!captured) throw new Error("context handler not registered");
  return { handler: captured };
}

function makeCtx(sessionManager: object): ExtensionContext {
  return {
    sessionManager,
    model: { contextWindow: 200_000 },
  } as unknown as ExtensionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contextPruningExtension", () => {
  const sessionManager = makeSessionManager();
  const ctx = makeCtx(sessionManager);

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset runtime state
    setContextPruningRuntime(sessionManager, null);
  });

  afterEach(() => {
    setContextPruningRuntime(sessionManager, null);
  });

  // -- Basic behavior -------------------------------------------------------

  it("does nothing when no runtime is registered", () => {
    const { handler } = buildExtensionAndCapture();
    const event = { messages: makeMessages(5) } as unknown as ContextEvent;
    const result = handler(event, ctx);
    expect(result).toBeUndefined();
    expect(mockPruneContextMessages).not.toHaveBeenCalled();
  });

  it("does nothing when TTL has not expired", () => {
    setContextPruningRuntime(sessionManager, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now(), // Just touched
    });
    const { handler } = buildExtensionAndCapture();
    const event = { messages: makeMessages(5) } as unknown as ContextEvent;
    const result = handler(event, ctx);
    expect(result).toBeUndefined();
  });

  it("does nothing when pruning returns the same messages array", () => {
    const originalMessages = makeMessages(5);
    setContextPruningRuntime(sessionManager, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - 600_000,
    });
    mockPruneContextMessages.mockReturnValue(originalMessages);

    const { handler } = buildExtensionAndCapture();
    const event = { messages: originalMessages } as unknown as ContextEvent;
    const result = handler(event, ctx);
    expect(result).toBeUndefined();
    expect(mockUpdateSessionStoreEntry).not.toHaveBeenCalled();
  });

  // -- Persistence after pruning -------------------------------------------

  it("persists token count after successful pruning when sessionKey and storePath are set", () => {
    const originalMessages = makeMessages(10);
    const prunedMessages = makePrunedMessages(3);

    setContextPruningRuntime(sessionManager, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - 600_000,
      sessionKey: "test-session",
      storePath: "/tmp/sessions.json",
    });
    mockPruneContextMessages.mockReturnValue(prunedMessages);

    const { handler } = buildExtensionAndCapture();
    const event = { messages: originalMessages } as unknown as ContextEvent;
    const result = handler(event, ctx);

    expect(result).toEqual({ messages: prunedMessages });
    expect(mockUpdateSessionStoreEntry).toHaveBeenCalledTimes(1);

    const callArgs = mockUpdateSessionStoreEntry.mock.calls[0]![0];
    expect(callArgs.storePath).toBe("/tmp/sessions.json");
    expect(callArgs.sessionKey).toBe("test-session");
    expect(typeof callArgs.update).toBe("function");
  });

  it("does NOT persist when sessionKey is missing", () => {
    const originalMessages = makeMessages(10);
    const prunedMessages = makePrunedMessages(3);

    setContextPruningRuntime(sessionManager, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - 600_000,
      storePath: "/tmp/sessions.json",
      // sessionKey intentionally omitted
    });
    mockPruneContextMessages.mockReturnValue(prunedMessages);

    const { handler } = buildExtensionAndCapture();
    const event = { messages: originalMessages } as unknown as ContextEvent;
    handler(event, ctx);

    expect(mockUpdateSessionStoreEntry).not.toHaveBeenCalled();
  });

  it("does NOT persist when storePath is missing", () => {
    const originalMessages = makeMessages(10);
    const prunedMessages = makePrunedMessages(3);

    setContextPruningRuntime(sessionManager, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - 600_000,
      sessionKey: "test-session",
      // storePath intentionally omitted
    });
    mockPruneContextMessages.mockReturnValue(prunedMessages);

    const { handler } = buildExtensionAndCapture();
    const event = { messages: originalMessages } as unknown as ContextEvent;
    handler(event, ctx);

    expect(mockUpdateSessionStoreEntry).not.toHaveBeenCalled();
  });

  it("swallows persistence errors without throwing", async () => {
    const originalMessages = makeMessages(10);
    const prunedMessages = makePrunedMessages(3);

    mockUpdateSessionStoreEntry.mockRejectedValueOnce(new Error("disk full"));

    setContextPruningRuntime(sessionManager, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - 600_000,
      sessionKey: "test-session",
      storePath: "/tmp/sessions.json",
    });
    mockPruneContextMessages.mockReturnValue(prunedMessages);

    const { handler } = buildExtensionAndCapture();
    const event = { messages: originalMessages } as unknown as ContextEvent;

    // Should not throw
    const result = handler(event, ctx);
    expect(result).toEqual({ messages: prunedMessages });

    // Wait for the fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(mockUpdateSessionStoreEntry).toHaveBeenCalledTimes(1);
  });

  // -- Update callback verification ----------------------------------------

  it("update callback computes correct estimated tokens from pruned messages", async () => {
    const prunedMessages = makePrunedMessages(3);
    const expectedChars = estimateContextChars(prunedMessages as any);
    const expectedTokens = Math.round(expectedChars / CHARS_PER_TOKEN_ESTIMATE);

    setContextPruningRuntime(sessionManager, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - 600_000,
      sessionKey: "test-session",
      storePath: "/tmp/sessions.json",
    });
    mockPruneContextMessages.mockReturnValue(prunedMessages);

    const { handler } = buildExtensionAndCapture();
    handler({ messages: makeMessages(10) } as unknown as ContextEvent, ctx);

    const callArgs = mockUpdateSessionStoreEntry.mock.calls[0]![0];
    const patch = await callArgs.update({
      sessionId: "sid",
      updatedAt: 0,
      inputTokens: 1000,
      outputTokens: 500,
      contextTokens: 200_000,
    });

    expect(patch.contextTokens).toBe(expectedTokens);
    expect(patch.totalTokens).toBe(Math.max(expectedTokens, 1000 + 500));
    expect(typeof patch.updatedAt).toBe("number");
  });

  it("totalTokens is at least the estimated token count", async () => {
    const prunedMessages = [{ role: "user" as const, content: "x".repeat(40_000) }];
    const expectedChars = estimateContextChars(prunedMessages as any);
    const expectedTokens = Math.round(expectedChars / CHARS_PER_TOKEN_ESTIMATE);

    setContextPruningRuntime(sessionManager, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - 600_000,
      sessionKey: "s",
      storePath: "/tmp/s.json",
    });
    mockPruneContextMessages.mockReturnValue(prunedMessages);

    const { handler } = buildExtensionAndCapture();
    handler({ messages: makeMessages(20) } as unknown as ContextEvent, ctx);

    const callArgs = mockUpdateSessionStoreEntry.mock.calls[0]![0];
    // Entry with very low input/output tokens
    const patch = await callArgs.update({
      sessionId: "sid",
      updatedAt: 0,
      inputTokens: 10,
      outputTokens: 5,
    });

    expect(patch.totalTokens).toBe(expectedTokens);
  });

  // -- TTL behavior ---------------------------------------------------------

  it("updates lastCacheTouchAt after pruning", () => {
    const originalMessages = makeMessages(10);
    const prunedMessages = makePrunedMessages(3);

    const runtime: ContextPruningRuntimeValue = {
      settings: makeSettings(),
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - 600_000,
      sessionKey: "s",
      storePath: "/tmp/s.json",
    };
    setContextPruningRuntime(sessionManager, runtime);
    mockPruneContextMessages.mockReturnValue(prunedMessages);

    const before = Date.now();
    const { handler } = buildExtensionAndCapture();
    handler({ messages: originalMessages } as unknown as ContextEvent, ctx);

    expect(runtime.lastCacheTouchAt).toBeGreaterThanOrEqual(before);
    expect(runtime.lastCacheTouchAt).toBeLessThanOrEqual(Date.now());
  });

  it("does nothing when TTL is zero", () => {
    setContextPruningRuntime(sessionManager, {
      settings: makeSettings({ ttlMs: 0 }),
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - 600_000,
    });

    const { handler } = buildExtensionAndCapture();
    const result = handler({ messages: makeMessages(5) } as unknown as ContextEvent, ctx);
    expect(result).toBeUndefined();
    expect(mockPruneContextMessages).not.toHaveBeenCalled();
  });

  it("does nothing when no lastCacheTouchAt is set", () => {
    setContextPruningRuntime(sessionManager, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      lastCacheTouchAt: null,
    });

    const { handler } = buildExtensionAndCapture();
    const result = handler({ messages: makeMessages(5) } as unknown as ContextEvent, ctx);
    expect(result).toBeUndefined();
  });
});
