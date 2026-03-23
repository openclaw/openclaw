import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  resolveAcpSpawnStreamLogPath,
  startAcpSpawnParentStreamRelay,
} from "./acp-spawn-parent-stream.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const readAcpSessionEntryMock = vi.fn();
const resolveSessionFilePathMock = vi.fn();
const resolveSessionFilePathOptionsMock = vi.fn();
const routeReplyMock = vi.fn();
const loadSessionEntryMock = vi.fn();
const deliveryContextFromSessionMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntry: (...args: unknown[]) => readAcpSessionEntryMock(...args),
}));

vi.mock("../auto-reply/reply/route-reply.js", () => ({
  routeReply: (...args: unknown[]) => routeReplyMock(...args),
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionFilePath: (...args: unknown[]) => resolveSessionFilePathMock(...args),
  resolveSessionFilePathOptions: (...args: unknown[]) => resolveSessionFilePathOptionsMock(...args),
}));

vi.mock("../gateway/session-utils.js", () => ({
  loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
}));

vi.mock("../utils/delivery-context.js", () => ({
  deliveryContextFromSession: (...args: unknown[]) => deliveryContextFromSessionMock(...args),
}));

function collectedTexts() {
  return enqueueSystemEventMock.mock.calls.map((call) => String(call[0] ?? ""));
}

describe("startAcpSpawnParentStreamRelay", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    readAcpSessionEntryMock.mockReset();
    resolveSessionFilePathMock.mockReset();
    resolveSessionFilePathOptionsMock.mockReset();
    routeReplyMock.mockReset();
    loadSessionEntryMock.mockReset();
    deliveryContextFromSessionMock.mockReset();
    resolveSessionFilePathOptionsMock.mockImplementation((value: unknown) => value);
    routeReplyMock.mockResolvedValue(undefined);
    loadSessionEntryMock.mockReturnValue({
      cfg: {
        channels: {},
      },
      entry: {
        sessionKey: "agent:main:main",
      },
    });
    deliveryContextFromSessionMock.mockReturnValue(undefined);
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

  it("delivers the final child output back to non-threaded direct chats", async () => {
    deliveryContextFromSessionMock.mockReturnValue({
      channel: "whatsapp",
      to: "+15551234567",
      accountId: "default",
    });

    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-4b",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-4b",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-4b",
      stream: "assistant",
      data: {
        delta: "hello",
      },
    });
    emitAgentEvent({
      runId: "run-4b",
      stream: "assistant",
      data: {
        delta: " world",
      },
    });
    vi.advanceTimersByTime(15);

    emitAgentEvent({
      runId: "run-4b",
      stream: "lifecycle",
      data: {
        phase: "end",
      },
    });
    await Promise.resolve();

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15551234567",
        accountId: "default",
        sessionKey: "agent:main:main",
        payload: { text: "hello world" },
      }),
    );
    relay.dispose();
  });

  it("does not direct-reply for threaded delivery contexts", async () => {
    deliveryContextFromSessionMock.mockReturnValue({
      channel: "slack",
      to: "C123",
      threadId: "thread-1",
    });

    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-4c",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-4c",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-4c",
      stream: "assistant",
      data: {
        delta: "thread reply should stay internal",
      },
    });
    vi.advanceTimersByTime(15);

    emitAgentEvent({
      runId: "run-4c",
      stream: "lifecycle",
      data: {
        phase: "end",
      },
    });
    await Promise.resolve();

    expect(routeReplyMock).not.toHaveBeenCalled();
    relay.dispose();
  });

  it("keeps the relay alive when parent session delivery context lookup fails", () => {
    loadSessionEntryMock.mockImplementation(() => {
      throw new Error("bad config");
    });

    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-4d",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-4d",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-4d",
      stream: "assistant",
      data: {
        delta: "still relays progress",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("Started codex session"))).toBe(true);
    expect(texts.some((text) => text.includes("codex: still relays progress"))).toBe(true);
    expect(routeReplyMock).not.toHaveBeenCalled();
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

  it("delivers direct-chat child failures back to the parent channel", async () => {
    deliveryContextFromSessionMock.mockReturnValue({
      channel: "telegram",
      to: "123456",
    });

    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-5b",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-5b",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-5b",
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "boom",
      },
    });
    await Promise.resolve();

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
        sessionKey: "agent:main:main",
        payload: { text: "boom" },
      }),
    );
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
