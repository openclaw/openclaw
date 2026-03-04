import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeSession } from "../../agents/agent-runtime.js";

function makeMockSession() {
  return {
    subscribe: vi.fn(() => vi.fn()),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    abortCompaction: vi.fn(),
    dispose: vi.fn(),
    isStreaming: false,
    isCompacting: false,
    messages: [] as unknown[],
    sessionId: "test-session",
    agent: {
      streamFn: vi.fn(),
      replaceMessages: vi.fn(),
      setSystemPrompt: vi.fn(),
    },
  };
}

const defaultHints = {
  allowSyntheticToolResults: true,
  enforceFinalTag: true,
  managesOwnHistory: false,
  supportsStreamFnWrapping: true,
  sessionFile: "/tmp/test.jsonl",
};

describe("PiRuntimeAdapter", () => {
  it("implements AgentRuntimeSession interface", async () => {
    const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");

    const mockSession = makeMockSession();

    const adapter: AgentRuntimeSession = createPiRuntimeAdapter({
      session: mockSession as never,
      runtimeHints: defaultHints,
    });

    expect(adapter.sessionId).toBe("test-session");
    expect(adapter.runtimeHints.allowSyntheticToolResults).toBe(true);
    expect(adapter.runtimeHints.enforceFinalTag).toBe(true);

    adapter.replaceMessages([]);
    expect(mockSession.agent.replaceMessages).toHaveBeenCalledWith([]);

    void adapter.abort();
    expect(mockSession.abort).toHaveBeenCalled();
  });

  describe("method delegation", () => {
    it("subscribe: calls session.subscribe and returns the unsubscribe fn", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();
      const unsubscribeFn = vi.fn();
      mockSession.subscribe.mockReturnValue(unsubscribeFn);

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      const handler = vi.fn();
      const returned = adapter.subscribe(handler);

      expect(mockSession.subscribe).toHaveBeenCalledWith(handler);
      expect(returned).toBe(unsubscribeFn);
    });

    it("prompt: calls session.prompt with text and options, returns the promise", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();
      const resolvedPromise = Promise.resolve();
      mockSession.prompt.mockReturnValue(resolvedPromise);

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      const options = { images: [] };
      const result = adapter.prompt("hello", options);

      expect(mockSession.prompt).toHaveBeenCalledWith("hello", options);
      expect(result).toBe(resolvedPromise);
    });

    it("steer: calls session.steer with the text", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      void adapter.steer("steer-text");

      expect(mockSession.steer).toHaveBeenCalledWith("steer-text");
    });

    it("abort: calls session.abort", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      void adapter.abort();

      expect(mockSession.abort).toHaveBeenCalled();
    });

    it("abortCompaction: calls session.abortCompaction", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      adapter.abortCompaction();

      expect(mockSession.abortCompaction).toHaveBeenCalled();
    });

    it("dispose: calls session.dispose", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      adapter.dispose();

      expect(mockSession.dispose).toHaveBeenCalled();
    });
  });

  describe("live getter behavior", () => {
    it("isStreaming reads live from session, not a snapshot", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();
      mockSession.isStreaming = false;

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      expect(adapter.isStreaming).toBe(false);

      (mockSession as { isStreaming: boolean }).isStreaming = true;
      expect(adapter.isStreaming).toBe(true);
    });

    it("isCompacting reads live from session, not a snapshot", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();
      mockSession.isCompacting = false;

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      expect(adapter.isCompacting).toBe(false);

      (mockSession as { isCompacting: boolean }).isCompacting = true;
      expect(adapter.isCompacting).toBe(true);
    });

    it("messages reads live from session, not a snapshot", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();
      const initialMessages: unknown[] = [];
      mockSession.messages = initialMessages;

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      expect(adapter.messages).toBe(initialMessages);

      const newMessages = [{ role: "user" }] as unknown[];
      (mockSession as { messages: unknown[] }).messages = newMessages;
      expect(adapter.messages).toBe(newMessages);
    });

    it("sessionId returns session.sessionId", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      expect(adapter.sessionId).toBe("test-session");
    });
  });

  describe("runtimeHints passthrough", () => {
    it("passes all 5 hint fields through exactly as provided", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();
      const hints = {
        allowSyntheticToolResults: false,
        enforceFinalTag: false,
        managesOwnHistory: true,
        supportsStreamFnWrapping: false,
        sessionFile: "/custom/path/session.jsonl",
      };

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: hints,
      });

      expect(adapter.runtimeHints.allowSyntheticToolResults).toBe(false);
      expect(adapter.runtimeHints.enforceFinalTag).toBe(false);
      expect(adapter.runtimeHints.managesOwnHistory).toBe(true);
      expect(adapter.runtimeHints.supportsStreamFnWrapping).toBe(false);
      expect(adapter.runtimeHints.sessionFile).toBe("/custom/path/session.jsonl");
    });

    it("passes undefined sessionFile through when not provided", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();
      const hints = {
        allowSyntheticToolResults: true,
        enforceFinalTag: true,
        managesOwnHistory: false,
        supportsStreamFnWrapping: true,
      };

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: hints,
      });
      expect(adapter.runtimeHints.sessionFile).toBeUndefined();
    });
  });

  describe("replaceMessages", () => {
    it("delegates to session.agent.replaceMessages with the exact array", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      const messages = [{ role: "user" }, { role: "assistant" }] as never[];
      adapter.replaceMessages(messages);

      expect(mockSession.agent.replaceMessages).toHaveBeenCalledWith(messages);
      expect(mockSession.agent.replaceMessages).toHaveBeenCalledTimes(1);
    });
  });

  describe("setSystemPrompt", () => {
    it("delegates to session.agent.setSystemPrompt with the provided text", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      adapter.setSystemPrompt?.("new-system");

      expect(mockSession.agent.setSystemPrompt).toHaveBeenCalledWith("new-system");
      expect(mockSession.agent.setSystemPrompt).toHaveBeenCalledTimes(1);
    });

    it("passes each call through to session.agent.setSystemPrompt", async () => {
      const { createPiRuntimeAdapter } = await import("./pi-runtime-adapter.js");
      const mockSession = makeMockSession();

      const adapter = createPiRuntimeAdapter({
        session: mockSession as never,
        runtimeHints: defaultHints,
      });
      adapter.setSystemPrompt?.("first");
      adapter.setSystemPrompt?.("updated-system");

      expect(mockSession.agent.setSystemPrompt).toHaveBeenLastCalledWith("updated-system");
      expect(mockSession.agent.setSystemPrompt).toHaveBeenCalledTimes(2);
    });
  });
});
