import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventPayload } from "../infra/agent-events.js";

// Capture the listener registered via onAgentEvent.
let capturedListener: ((evt: AgentEventPayload) => void) | null = null;
const onAgentEventMock = vi.fn((listener: (evt: AgentEventPayload) => void) => {
  capturedListener = listener;
  return () => {
    capturedListener = null;
  };
});

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: (...args: unknown[]) => onAgentEventMock(...(args as [never])),
}));

const routeReplyMock = vi.fn(async () => ({ ok: true }));
vi.mock("../auto-reply/reply/route-reply.js", () => ({
  routeReply: (...args: unknown[]) => routeReplyMock(...args),
}));

const maybeQueueMock = vi.fn(async () => "none" as const);
vi.mock("./subagent-announce.js", () => ({
  maybeQueueSubagentAnnounce: (...args: unknown[]) => maybeQueueMock(...args),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: () => {}, error: () => {} },
}));

function emitToolEvent(
  runId: string,
  phase: "start" | "update" | "result",
  name: string,
  extra?: Record<string, unknown> & { sessionKey?: string },
) {
  if (!capturedListener) {
    throw new Error("No listener registered");
  }
  const { sessionKey, ...rest } = extra ?? {};
  capturedListener({
    runId,
    seq: 1,
    stream: "tool",
    ts: Date.now(),
    data: { phase, name, ...rest },
    ...(sessionKey ? { sessionKey } : {}),
  });
}

describe("subscribeSubagentProgress", () => {
  let subscribeSubagentProgress: typeof import("./subagent-progress.js").subscribeSubagentProgress;

  beforeEach(async () => {
    vi.useFakeTimers();
    capturedListener = null;
    routeReplyMock.mockClear();
    maybeQueueMock.mockClear();
    onAgentEventMock.mockClear();
    const mod = await import("./subagent-progress.js");
    subscribeSubagentProgress = mod.subscribeSubagentProgress;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers an event listener and returns cleanup function", () => {
    const stop = subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
    });
    expect(onAgentEventMock).toHaveBeenCalledTimes(1);
    expect(typeof stop).toBe("function");
    stop();
    expect(capturedListener).toBeNull();
  });

  it("relays tool start events to channel", async () => {
    subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "slack", to: "C123" },
    });

    emitToolEvent("run-1", "start", "read", { args: { path: "src/foo.ts" } });

    // Allow async routeReply to execute
    await vi.advanceTimersByTimeAsync(0);

    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    const callArgs = routeReplyMock.mock.calls[0][0] as { payload: { text: string } };
    expect(callArgs.payload.text).toContain("Read");
  });

  it("ignores events from different runIds", async () => {
    subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "slack", to: "C123" },
    });

    emitToolEvent("run-other", "start", "read", { args: { path: "src/foo.ts" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(routeReplyMock).not.toHaveBeenCalled();
  });

  it("matches events by sessionKey when runId differs", async () => {
    subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "slack", to: "C123" },
    });

    // Different runId but matching sessionKey should still be processed
    emitToolEvent("run-different", "start", "read", {
      args: { path: "src/foo.ts" },
      sessionKey: "agent:main:subagent:test",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    const callArgs = routeReplyMock.mock.calls[0][0] as { payload: { text: string } };
    expect(callArgs.payload.text).toContain("Read");
  });

  it("ignores events with neither matching runId nor sessionKey", async () => {
    subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "slack", to: "C123" },
    });

    emitToolEvent("run-other", "start", "read", {
      args: { path: "src/foo.ts" },
      sessionKey: "agent:main:subagent:other",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(routeReplyMock).not.toHaveBeenCalled();
  });

  it("throttles channel messages", async () => {
    subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "slack", to: "C123" },
      channelThrottleMs: 5_000,
    });

    // First event goes through
    emitToolEvent("run-1", "start", "read", { args: { path: "a.ts" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(routeReplyMock).toHaveBeenCalledTimes(1);

    // Second event within throttle window is skipped
    emitToolEvent("run-1", "start", "edit", { args: { path: "b.ts" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(routeReplyMock).toHaveBeenCalledTimes(1);

    // After throttle window, next event goes through
    await vi.advanceTimersByTimeAsync(5_001);
    emitToolEvent("run-1", "start", "write", { args: { path: "c.ts" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(routeReplyMock).toHaveBeenCalledTimes(2);
  });

  it("skips channel relay when no requesterOrigin", async () => {
    subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      // no requesterOrigin
    });

    emitToolEvent("run-1", "start", "read", { args: { path: "src/foo.ts" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(routeReplyMock).not.toHaveBeenCalled();
  });

  it("sends parent report after interval", async () => {
    subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      label: "test-task",
      parentReportIntervalMs: 10_000,
    });

    emitToolEvent("run-1", "start", "read", { args: { path: "src/foo.ts" } });

    // Parent report scheduled but not yet sent
    expect(maybeQueueMock).not.toHaveBeenCalled();

    // Advance past the parent report interval
    await vi.advanceTimersByTimeAsync(10_001);

    expect(maybeQueueMock).toHaveBeenCalledTimes(1);
    const queueArgs = maybeQueueMock.mock.calls[0][0] as {
      triggerMessage: string;
      summaryLine: string;
    };
    expect(queueArgs.triggerMessage).toContain("test-task");
    expect(queueArgs.triggerMessage).toContain("read (1)");
    expect(queueArgs.summaryLine).toContain("progress");
  });

  it("relays error events to channel", async () => {
    subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "slack", to: "C123" },
    });

    // First send a start event (takes the first throttle slot)
    emitToolEvent("run-1", "start", "read", { args: { path: "a.ts" } });
    await vi.advanceTimersByTimeAsync(0);

    // Advance past throttle
    await vi.advanceTimersByTimeAsync(5_001);

    // Now send an error result
    emitToolEvent("run-1", "result", "read", { isError: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(routeReplyMock).toHaveBeenCalledTimes(2);
    const errorCall = routeReplyMock.mock.calls[1][0] as { payload: { text: string } };
    expect(errorCall.payload.text).toContain("❌");
    expect(errorCall.payload.text).toContain("read");
  });

  it("cleans up timer on stop", async () => {
    const stop = subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      parentReportIntervalMs: 10_000,
    });

    emitToolEvent("run-1", "start", "read", { args: { path: "a.ts" } });
    stop();

    // Advance past the parent report interval — should not fire
    await vi.advanceTimersByTimeAsync(10_001);
    expect(maybeQueueMock).not.toHaveBeenCalled();
  });

  it("processes tool events with parentTool field from claude_code", async () => {
    subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "slack", to: "C123" },
    });

    // Simulate a claude_code internal tool event with parentTool field and args
    emitToolEvent("run-1", "start", "Read", {
      args: { path: "src/foo.ts" },
      parentTool: "claude_code",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    const callArgs = routeReplyMock.mock.calls[0][0] as { payload: { text: string } };
    expect(callArgs.payload.text).toContain("Read");
    // args.path should be resolved by resolveToolDisplay into the summary
    expect(callArgs.payload.text).toContain("src/foo.ts");
  });

  it("tracks tool counts correctly across multiple starts", async () => {
    subscribeSubagentProgress({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      label: "counter-test",
      parentReportIntervalMs: 5_000,
    });

    emitToolEvent("run-1", "start", "read", { args: { path: "a.ts" } });
    emitToolEvent("run-1", "result", "read", {});
    emitToolEvent("run-1", "start", "read", { args: { path: "b.ts" } });
    emitToolEvent("run-1", "result", "read", {});
    emitToolEvent("run-1", "start", "edit", { args: { path: "c.ts" } });

    await vi.advanceTimersByTimeAsync(5_001);

    expect(maybeQueueMock).toHaveBeenCalledTimes(1);
    const queueArgs = maybeQueueMock.mock.calls[0][0] as { triggerMessage: string };
    expect(queueArgs.triggerMessage).toContain("read (2)");
    expect(queueArgs.triggerMessage).toContain("edit (1)");
  });
});
