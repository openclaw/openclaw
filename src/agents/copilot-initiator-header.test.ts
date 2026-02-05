import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { CopilotInitiatorTracker, createCopilotAwareStream } from "./copilot-initiator-header.js";

describe("CopilotInitiatorTracker", () => {
  it("should return 'user' on first call for a session", () => {
    const tracker = new CopilotInitiatorTracker();
    const result = tracker.getInitiator("session-123");
    expect(result).toBe("user");
  });

  it("should return 'agent' on subsequent calls for the same session", () => {
    const tracker = new CopilotInitiatorTracker();
    tracker.getInitiator("session-123"); // First call
    const result = tracker.getInitiator("session-123"); // Second call
    expect(result).toBe("agent");
  });

  it("should track multiple sessions independently", () => {
    const tracker = new CopilotInitiatorTracker();
    const session1 = "session-abc";
    const session2 = "session-xyz";

    // First call for each session should return 'user'
    expect(tracker.getInitiator(session1)).toBe("user");
    expect(tracker.getInitiator(session2)).toBe("user");

    // Subsequent calls for each should return 'agent'
    expect(tracker.getInitiator(session1)).toBe("agent");
    expect(tracker.getInitiator(session2)).toBe("agent");
  });

  it("should reset session tracking", () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "session-reset";

    // First call returns 'user'
    expect(tracker.getInitiator(sessionId)).toBe("user");
    // Subsequent calls return 'agent'
    expect(tracker.getInitiator(sessionId)).toBe("agent");

    // Reset the session
    tracker.reset(sessionId);

    // After reset, first call should return 'user' again
    expect(tracker.getInitiator(sessionId)).toBe("user");
  });

  it("should cleanup old sessions", () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "session-cleanup";

    // First call creates a session entry
    expect(tracker.getInitiator(sessionId)).toBe("user");

    // Advance time by 25 hours (past the 24-hour cleanup interval)
    vi.useFakeTimers();
    vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25 hours

    // Run cleanup
    tracker.cleanup();

    // Session should be cleaned up, so getInitiator returns 'user' again
    expect(tracker.getInitiator(sessionId)).toBe("user");

    vi.useRealTimers();
  });
});

describe("createCopilotAwareStream", () => {
  it("should inject X-Initiator: user header for first Copilot call", async () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "test-session-1";

    let capturedHeaders: Record<string, string> | undefined;
    const mockStream: StreamFn = vi.fn().mockImplementation(async (_model, _context, options) => {
      capturedHeaders = options?.headers as Record<string, string> | undefined;
      return new AssistantMessageEventStream();
    });

    const wrappedStream = createCopilotAwareStream(
      "github-copilot",
      sessionId,
      tracker,
      mockStream,
    );

    const model = {
      api: "openai-completions",
      provider: "github-copilot",
      id: "gpt-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    await wrappedStream(model, context, {});

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.["X-Initiator"]).toBe("user");
  });

  it("should inject X-Initiator: agent header for subsequent Copilot calls", async () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "test-session-2";

    const mockStream: StreamFn = vi.fn().mockResolvedValue(new AssistantMessageEventStream());

    const wrappedStream = createCopilotAwareStream(
      "github-copilot",
      sessionId,
      tracker,
      mockStream,
    );

    const model = {
      api: "openai-completions",
      provider: "github-copilot",
      id: "gpt-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    // First call
    await wrappedStream(model, context, {});

    // Second call should get initiator="agent"
    let capturedHeaders: Record<string, string> | undefined;
    vi.mocked(mockStream).mockImplementationOnce(async (_model, _context, options) => {
      capturedHeaders = options?.headers as Record<string, string> | undefined;
      return new AssistantMessageEventStream();
    });

    await wrappedStream(model, context, {});

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.["X-Initiator"]).toBe("agent");
  });

  it("should not inject header for non-Copilot providers", async () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "test-session-3";

    let capturedHeaders: Record<string, string> | undefined;
    const mockStream: StreamFn = vi.fn().mockImplementation(async (_model, _context, options) => {
      capturedHeaders = options?.headers as Record<string, string> | undefined;
      return new AssistantMessageEventStream();
    });

    const wrappedStream = createCopilotAwareStream("anthropic", sessionId, tracker, mockStream);

    const model = {
      api: "anthropic-completions",
      provider: "anthropic",
      id: "claude-3-5-sonnet",
    } as Model<"anthropic-completions">;
    const context: Context = { messages: [] };

    await wrappedStream(model, context, {});

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.["X-Initiator"]).toBeUndefined();
  });
});
