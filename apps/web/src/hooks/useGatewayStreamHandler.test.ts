import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGatewayStreamHandler } from "./useGatewayStreamHandler";

const toastLoading = vi.fn();
const toastDismiss = vi.fn();
const toastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    loading: toastLoading,
    dismiss: toastDismiss,
    error: toastError,
  },
}));

type GatewayEvent = { event: string; payload?: unknown };

let gatewayEventHandler: ((event: GatewayEvent) => void) | null = null;
const addEventListener = vi.fn((handler: (event: GatewayEvent) => void) => {
  gatewayEventHandler = handler;
  return () => {
    gatewayEventHandler = null;
  };
});

vi.mock("@/providers/GatewayProvider", () => ({
  useOptionalGateway: () => ({ addEventListener }),
}));

const state = {
  currentRunIds: {} as Record<string, string>,
  streamingMessages: {} as Record<string, unknown>,
};

const startStreaming = vi.fn((sessionKey: string, runId: string) => {
  state.currentRunIds[sessionKey] = runId;
  state.streamingMessages[sessionKey] = {
    content: "",
    toolCalls: [],
    isStreaming: true,
  };
});
const setStreamingContent = vi.fn();
const appendStreamingContent = vi.fn();
const updateToolCall = vi.fn();
const finishStreaming = vi.fn();
const clearStreaming = vi.fn();
const findSessionKeyByRunId = vi.fn((runId: string) => {
  for (const [sessionKey, id] of Object.entries(state.currentRunIds)) {
    if (id === runId) return sessionKey;
  }
  return null;
});

const useSessionStoreMock = vi.fn((selector?: (s: unknown) => unknown) => {
  const store = {
    ...state,
    startStreaming,
    setStreamingContent,
    appendStreamingContent,
    updateToolCall,
    finishStreaming,
    clearStreaming,
    findSessionKeyByRunId,
  };
  return selector ? selector(store) : store;
});
useSessionStoreMock.getState = () => ({
  ...state,
  startStreaming,
  setStreamingContent,
  appendStreamingContent,
  updateToolCall,
  finishStreaming,
  clearStreaming,
  findSessionKeyByRunId,
});

vi.mock("@/stores/useSessionStore", () => ({
  useSessionStore: useSessionStoreMock,
}));

describe("useGatewayStreamHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayEventHandler = null;
    state.currentRunIds = {};
    state.streamingMessages = {};
  });

  it("subscribes to gateway events when enabled", () => {
    renderHook(() => useGatewayStreamHandler({ enabled: true }));
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(typeof gatewayEventHandler).toBe("function");
  });

  it("routes chat deltas as content snapshots", () => {
    renderHook(() => useGatewayStreamHandler({ enabled: true }));

    gatewayEventHandler?.({
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: "session-1",
        seq: 1,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }], timestamp: 0 },
      },
    });

    expect(startStreaming).toHaveBeenCalledWith("session-1", "run-1");
    expect(setStreamingContent).toHaveBeenCalledWith("session-1", "Hello");
    expect(appendStreamingContent).not.toHaveBeenCalled();
  });

  it("routes agent tool stream events to tool calls (sessionKey fallback via runId)", () => {
    renderHook(() => useGatewayStreamHandler({ enabled: true }));

    // Seed currentRunIds and streamingMessages via a chat delta.
    gatewayEventHandler?.({
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: "session-1",
        seq: 1,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "" }], timestamp: 0 },
      },
    });

    gatewayEventHandler?.({
      event: "agent",
      payload: {
        runId: "run-1",
        seq: 2,
        stream: "tool",
        ts: 0,
        data: {
          phase: "start",
          toolCallId: "tool-123",
          name: "exec",
          input: { cmd: "ls" },
        },
      },
    });

    expect(findSessionKeyByRunId).toHaveBeenCalledWith("run-1");
    expect(updateToolCall).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        id: "tool-123",
        name: "exec",
        status: "running",
      })
    );
  });

  it("shows compaction start/end toasts", () => {
    renderHook(() => useGatewayStreamHandler({ enabled: true }));

    // Seed run -> session mapping
    gatewayEventHandler?.({
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: "session-1",
        seq: 1,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "" }], timestamp: 0 },
      },
    });

    gatewayEventHandler?.({
      event: "agent",
      payload: {
        runId: "run-1",
        seq: 2,
        stream: "compaction",
        ts: 0,
        data: { phase: "start" },
      },
    });

    expect(toastLoading).toHaveBeenCalledWith("Compacting context\u2026", { id: "compaction:session-1" });

    gatewayEventHandler?.({
      event: "agent",
      payload: {
        runId: "run-1",
        seq: 3,
        stream: "compaction",
        ts: 0,
        data: { phase: "end" },
      },
    });

    expect(toastDismiss).toHaveBeenCalledWith("compaction:session-1");
    expect(toastError).not.toHaveBeenCalled();
  });
});

