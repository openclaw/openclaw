import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  resolveAcpSpawnStreamLogPath,
  startAcpSpawnParentStreamRelay,
} from "./acp-spawn-parent-stream.js";

const callGatewayMock = vi.fn();
const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const readAcpSessionEntryMock = vi.fn();
const resolveSessionFilePathMock = vi.fn();
const resolveSessionFilePathOptionsMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../acp/runtime/session-meta.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/runtime/session-meta.js")>();
  return {
    ...actual,
    readAcpSessionEntry: (...args: unknown[]) => readAcpSessionEntryMock(...args),
  };
});

vi.mock("../config/sessions/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/paths.js")>();
  return {
    ...actual,
    resolveSessionFilePath: (...args: unknown[]) => resolveSessionFilePathMock(...args),
    resolveSessionFilePathOptions: (...args: unknown[]) =>
      resolveSessionFilePathOptionsMock(...args),
  };
});

function collectedTexts() {
  return enqueueSystemEventMock.mock.calls.map((call) => String(call[0] ?? ""));
}

describe("startAcpSpawnParentStreamRelay", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts?: { method?: string }) => {
      if (opts?.method === "chat.history") {
        return { messages: [] };
      }
      if (opts?.method === "agent.wait") {
        return { status: "timeout" };
      }
      throw new Error(`Unexpected method: ${String(opts?.method)}`);
    });
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    readAcpSessionEntryMock.mockReset();
    resolveSessionFilePathMock.mockReset();
    resolveSessionFilePathOptionsMock.mockReset();
    resolveSessionFilePathOptionsMock.mockImplementation((value: unknown) => value);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("relays assistant progress and completion to the parent session", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-1",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-1",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-1",
      stream: "assistant",
      data: {
        delta: "hello from child",
      },
    });
    vi.advanceTimersByTime(15);

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1_000,
        endedAt: 3_100,
      },
    });

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("Started codex session"))).toBe(true);
    expect(texts.some((text) => text.includes("codex: hello from child"))).toBe(true);
    expect(texts.some((text) => text.includes("codex run completed in 2s"))).toBe(true);
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      }),
    );
    relay.dispose();
  });

  it("emits a no-output notice and a resumed notice when output returns", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-2",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-2",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 1_000,
      noOutputPollMs: 250,
    });

    vi.advanceTimersByTime(1_500);
    expect(collectedTexts().some((text) => text.includes("has produced no output for 1s"))).toBe(
      true,
    );

    emitAgentEvent({
      runId: "run-2",
      stream: "assistant",
      data: {
        delta: "resumed output",
      },
    });
    vi.advanceTimersByTime(5);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("resumed output."))).toBe(true);
    expect(texts.some((text) => text.includes("codex: resumed output"))).toBe(true);

    emitAgentEvent({
      runId: "run-2",
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "boom",
      },
    });
    expect(collectedTexts().some((text) => text.includes("run failed: boom"))).toBe(true);
    relay.dispose();
  });

  it("auto-disposes stale relays after max lifetime timeout", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-3",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-3",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 0,
      maxRelayLifetimeMs: 1_000,
    });

    vi.advanceTimersByTime(1_001);
    expect(collectedTexts().some((text) => text.includes("stream relay timed out after 1s"))).toBe(
      true,
    );

    const before = enqueueSystemEventMock.mock.calls.length;
    emitAgentEvent({
      runId: "run-3",
      stream: "assistant",
      data: {
        delta: "late output",
      },
    });
    vi.advanceTimersByTime(5);

    expect(enqueueSystemEventMock.mock.calls).toHaveLength(before);
    relay.dispose();
  });

  it("supports delayed start notices", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-4",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-4",
      agentId: "codex",
      emitStartNotice: false,
    });

    expect(collectedTexts().some((text) => text.includes("Started codex session"))).toBe(false);

    relay.notifyStarted();

    expect(collectedTexts().some((text) => text.includes("Started codex session"))).toBe(true);
    relay.dispose();
  });

  it("preserves delta whitespace boundaries in progress relays", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-5",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-5",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-5",
      stream: "assistant",
      data: {
        delta: "hello",
      },
    });
    emitAgentEvent({
      runId: "run-5",
      stream: "assistant",
      data: {
        delta: " world",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("codex: hello world"))).toBe(true);
    relay.dispose();
  });

  it("falls back to child history and gateway wait when local events never arrive", async () => {
    callGatewayMock.mockImplementation(async (opts?: { method?: string }) => {
      if (opts?.method === "chat.history") {
        const isPrimingRead =
          callGatewayMock.mock.calls.filter(([call]) => call?.method === "chat.history").length ===
          1;
        return isPrimingRead
          ? { messages: [] }
          : {
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "READY_FROM_HISTORY" }],
                },
              ],
            };
      }
      if (opts?.method === "agent.wait") {
        return { status: "ok" };
      }
      throw new Error(`Unexpected method: ${String(opts?.method)}`);
    });

    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-6",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-6",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 120_000,
      noOutputPollMs: 250,
    });

    await vi.advanceTimersByTimeAsync(250);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("codex: READY_FROM_HISTORY"))).toBe(true);
    expect(texts.some((text) => text.includes("codex run completed."))).toBe(true);
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "chat.history",
        params: expect.objectContaining({
          sessionKey: "agent:codex:acp:child-6",
        }),
      }),
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({
          runId: "run-6",
          timeoutMs: 1,
        }),
      }),
    );
    relay.dispose();
  });

  it("falls back to gateway wait when assistant deltas arrive but lifecycle completion is missing", async () => {
    callGatewayMock.mockImplementation(async (opts?: { method?: string }) => {
      if (opts?.method === "chat.history") {
        return { messages: [] };
      }
      if (opts?.method === "agent.wait") {
        return { status: "ok" };
      }
      throw new Error(`Unexpected method: ${String(opts?.method)}`);
    });

    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-7",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-7",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 120_000,
      noOutputPollMs: 250,
    });

    emitAgentEvent({
      runId: "run-7",
      stream: "assistant",
      data: {
        delta: "READY_FROM_LOCAL",
      },
    });
    await vi.advanceTimersByTimeAsync(250);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("codex: READY_FROM_LOCAL"))).toBe(true);
    expect(texts.some((text) => text.includes("codex run completed."))).toBe(true);
    relay.dispose();
  });

  it("hydrates missing assistant output from history before a local lifecycle end completes", async () => {
    callGatewayMock.mockImplementation(async (opts?: { method?: string }) => {
      if (opts?.method === "chat.history") {
        const isPrimingRead =
          callGatewayMock.mock.calls.filter(([call]) => call?.method === "chat.history").length ===
          1;
        return isPrimingRead
          ? { messages: [] }
          : {
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "READY_BEFORE_LOCAL_END" }],
                },
              ],
            };
      }
      if (opts?.method === "agent.wait") {
        return { status: "timeout" };
      }
      throw new Error(`Unexpected method: ${String(opts?.method)}`);
    });

    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-8",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-8",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 120_000,
      noOutputPollMs: 250,
    });

    emitAgentEvent({
      runId: "run-8",
      stream: "lifecycle",
      data: {
        phase: "end",
      },
    });
    await vi.advanceTimersByTimeAsync(1);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("codex: READY_BEFORE_LOCAL_END"))).toBe(true);
    expect(texts.some((text) => text.includes("codex run completed."))).toBe(true);
    relay.dispose();
  });

  it("resolves ACP spawn stream log path from session metadata", () => {
    readAcpSessionEntryMock.mockReturnValue({
      storePath: "/tmp/openclaw/agents/codex/sessions/sessions.json",
      entry: {
        sessionId: "sess-123",
        sessionFile: "/tmp/openclaw/agents/codex/sessions/sess-123.jsonl",
      },
    });
    resolveSessionFilePathMock.mockReturnValue(
      "/tmp/openclaw/agents/codex/sessions/sess-123.jsonl",
    );

    const resolved = resolveAcpSpawnStreamLogPath({
      childSessionKey: "agent:codex:acp:child-1",
    });

    expect(resolved).toBe("/tmp/openclaw/agents/codex/sessions/sess-123.acp-stream.jsonl");
    expect(readAcpSessionEntryMock).toHaveBeenCalledWith({
      sessionKey: "agent:codex:acp:child-1",
    });
    expect(resolveSessionFilePathMock).toHaveBeenCalledWith(
      "sess-123",
      expect.objectContaining({
        sessionId: "sess-123",
      }),
      expect.objectContaining({
        storePath: "/tmp/openclaw/agents/codex/sessions/sessions.json",
      }),
    );
  });
});
