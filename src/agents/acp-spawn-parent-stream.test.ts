import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  resolveAcpSpawnStreamLogPath,
  startAcpSpawnParentStreamRelay,
} from "./acp-spawn-parent-stream.js";

const callGatewayMock = vi.fn();
const enqueueSystemEventMock = vi.fn();
const readAcpSessionEntryMock = vi.fn();
const resolveSessionFilePathMock = vi.fn();
const resolveSessionFilePathOptionsMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntry: (...args: unknown[]) => readAcpSessionEntryMock(...args),
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionFilePath: (...args: unknown[]) => resolveSessionFilePathMock(...args),
  resolveSessionFilePathOptions: (...args: unknown[]) => resolveSessionFilePathOptionsMock(...args),
}));

function collectedTexts() {
  return enqueueSystemEventMock.mock.calls.map((call) => String(call[0] ?? ""));
}

describe("startAcpSpawnParentStreamRelay", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    enqueueSystemEventMock.mockClear();
    readAcpSessionEntryMock.mockReset();
    resolveSessionFilePathMock.mockReset();
    resolveSessionFilePathOptionsMock.mockReset();
    resolveSessionFilePathOptionsMock.mockImplementation((value: unknown) => value);
    callGatewayMock.mockResolvedValue({ runId: "wake-run" });
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
      replyChannel: "telegram",
      replyTo: "telegram:1336356696",
      replyAccountId: "default",
      threadId: "39951",
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
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        expectFinal: true,
      }),
    );
    expect(
      callGatewayMock.mock.calls.some(([call]) => {
        const typed = call as {
          method?: string;
          expectFinal?: boolean;
          params?: {
            sessionKey?: string;
            deliver?: boolean;
            channel?: string;
            replyChannel?: string;
            replyTo?: string;
            replyAccountId?: string;
            threadId?: string;
            lane?: string;
            inputProvenance?: { kind?: string; sourceTool?: string };
          };
        };
        return (
          typed.method === "agent" &&
          typed.expectFinal === true &&
          typed.params?.sessionKey === "agent:main:main" &&
          typed.params?.deliver === true &&
          typed.params?.channel === "webchat" &&
          typed.params?.replyChannel === "telegram" &&
          typed.params?.replyTo === "telegram:1336356696" &&
          typed.params?.replyAccountId === "default" &&
          typed.params?.threadId === "39951" &&
          typed.params?.lane === "nested" &&
          typed.params?.inputProvenance?.kind === "inter_session" &&
          typed.params?.inputProvenance?.sourceTool === "acp_spawn"
        );
      }),
    ).toBeTruthy();
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
    expect(
      callGatewayMock.mock.calls.some(([call]) => {
        const typed = call as {
          method?: string;
          params?: { sessionKey?: string; deliver?: boolean };
        };
        return (
          typed.method === "agent" &&
          typed.params?.sessionKey === "agent:main:main" &&
          typed.params?.deliver === true
        );
      }),
    ).toBeTruthy();

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
