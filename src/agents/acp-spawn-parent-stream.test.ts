import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionMeta from "../acp/runtime/session-meta.js";
import * as sessionPaths from "../config/sessions/paths.js";
import * as gatewayCall from "../gateway/call.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import * as heartbeatWake from "../infra/heartbeat-wake.js";
import * as systemEvents from "../infra/system-events.js";
import {
  resolveAcpSpawnStreamLogPath,
  startAcpSpawnParentStreamRelay,
} from "./acp-spawn-parent-stream.js";
import * as subagentAnnounce from "./subagent-announce.js";
import * as subagentRegistry from "./subagent-registry.js";

describe("startAcpSpawnParentStreamRelay", () => {
  let enqueueSystemEventSpy: ReturnType<typeof vi.spyOn>;
  let requestHeartbeatNowSpy: ReturnType<typeof vi.spyOn>;
  let readAcpSessionEntrySpy: ReturnType<typeof vi.spyOn>;
  let resolveSessionFilePathSpy: ReturnType<typeof vi.spyOn>;
  let resolveSessionFilePathOptionsSpy: ReturnType<typeof vi.spyOn>;
  let callGatewaySpy: ReturnType<typeof vi.spyOn>;
  let readSubagentOutputSpy: ReturnType<typeof vi.spyOn>;
  let completeSubagentRunSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    enqueueSystemEventSpy = vi
      .spyOn(systemEvents, "enqueueSystemEvent")
      .mockImplementation(() => false);
    requestHeartbeatNowSpy = vi
      .spyOn(heartbeatWake, "requestHeartbeatNow")
      .mockImplementation(() => {});
    readAcpSessionEntrySpy = vi
      .spyOn(sessionMeta, "readAcpSessionEntry")
      .mockReturnValue(undefined as never);
    resolveSessionFilePathSpy = vi
      .spyOn(sessionPaths, "resolveSessionFilePath")
      .mockReturnValue("");
    resolveSessionFilePathOptionsSpy = vi
      .spyOn(sessionPaths, "resolveSessionFilePathOptions")
      .mockImplementation((value: unknown) => value as never);
    callGatewaySpy = vi.spyOn(gatewayCall, "callGateway").mockResolvedValue(undefined as never);
    readSubagentOutputSpy = vi
      .spyOn(subagentAnnounce, "readSubagentOutput")
      .mockResolvedValue(undefined);
    completeSubagentRunSpy = vi
      .spyOn(subagentRegistry, "completeSubagentRun")
      .mockResolvedValue(undefined as never);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T01:00:00.000Z"));
  });

  afterEach(() => {
    enqueueSystemEventSpy.mockRestore();
    requestHeartbeatNowSpy.mockRestore();
    readAcpSessionEntrySpy.mockRestore();
    resolveSessionFilePathSpy.mockRestore();
    resolveSessionFilePathOptionsSpy.mockRestore();
    callGatewaySpy.mockRestore();
    readSubagentOutputSpy.mockRestore();
    completeSubagentRunSpy.mockRestore();
    vi.useRealTimers();
  });

  function collectedTexts(): string[] {
    return enqueueSystemEventSpy.mock.calls.map((call: [string, ...unknown[]]) =>
      String(call[0] ?? ""),
    );
  }

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
    expect(texts.some((text: string) => text.includes("Started codex session"))).toBe(true);
    expect(texts.some((text: string) => text.includes("codex: hello from child"))).toBe(true);
    expect(texts.some((text: string) => text.includes("codex run completed in 2s"))).toBe(true);
    expect(requestHeartbeatNowSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      }),
    );
    relay.dispose();
  });

  it("emits a no-output notice and a resumed notice when output returns", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-2",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-2",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 1_000,
      noOutputPollMs: 250,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(
      collectedTexts().some((text: string) => text.includes("has produced no output for 1s")),
    ).toBe(true);

    emitAgentEvent({
      runId: "run-2",
      stream: "assistant",
      data: {
        delta: "resumed output",
      },
    });
    vi.advanceTimersByTime(5);

    const texts = collectedTexts();
    expect(texts.some((text: string) => text.includes("resumed output."))).toBe(true);
    expect(texts.some((text: string) => text.includes("codex: resumed output"))).toBe(true);

    emitAgentEvent({
      runId: "run-2",
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "boom",
      },
    });
    expect(collectedTexts().some((text: string) => text.includes("run failed: boom"))).toBe(true);
    relay.dispose();
  });

  it("auto-disposes stale relays after max lifetime timeout", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-3",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-3",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 0,
      maxRelayLifetimeMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_001);
    expect(
      collectedTexts().some((text: string) => text.includes("stream relay timed out after 1s")),
    ).toBe(true);

    const before = enqueueSystemEventSpy.mock.calls.length;
    emitAgentEvent({
      runId: "run-3",
      stream: "assistant",
      data: {
        delta: "late output",
      },
    });
    vi.advanceTimersByTime(5);

    expect(enqueueSystemEventSpy.mock.calls).toHaveLength(before);
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

    expect(collectedTexts().some((text: string) => text.includes("Started codex session"))).toBe(
      false,
    );

    relay.notifyStarted();

    expect(collectedTexts().some((text: string) => text.includes("Started codex session"))).toBe(
      true,
    );
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
    expect(texts.some((text: string) => text.includes("codex: hello world"))).toBe(true);
    relay.dispose();
  });

  it("resolves ACP spawn stream log path from session metadata", () => {
    readAcpSessionEntrySpy.mockReturnValue({
      storePath: "/tmp/openclaw/agents/codex/sessions/sessions.json",
      entry: {
        sessionId: "sess-123",
        sessionFile: "/tmp/openclaw/agents/codex/sessions/sess-123.jsonl",
      },
    });
    resolveSessionFilePathSpy.mockReturnValue("/tmp/openclaw/agents/codex/sessions/sess-123.jsonl");

    const resolved = resolveAcpSpawnStreamLogPath({
      childSessionKey: "agent:codex:acp:child-1",
    });

    expect(resolved).toBe("/tmp/openclaw/agents/codex/sessions/sess-123.acp-stream.jsonl");
    expect(readAcpSessionEntrySpy).toHaveBeenCalledWith({
      sessionKey: "agent:codex:acp:child-1",
    });
    expect(resolveSessionFilePathSpy).toHaveBeenCalledWith(
      "sess-123",
      expect.objectContaining({
        sessionId: "sess-123",
      }),
      expect.objectContaining({
        storePath: "/tmp/openclaw/agents/codex/sessions/sessions.json",
      }),
    );
  });

  it("probes for completed relay before emitting stall warning", async () => {
    callGatewaySpy.mockResolvedValue({ status: "ok", endedAt: Date.now() } as never);

    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-6",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-6",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 1_000,
      noOutputPollMs: 250,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    const texts = collectedTexts();
    expect(texts.some((text: string) => text.includes("has produced no output"))).toBe(false);
    expect(texts.some((text: string) => text.includes("run completed"))).toBe(true);
    relay.dispose();
  });

  it("uses transcript fallback before emitting stall warning", async () => {
    readSubagentOutputSpy.mockResolvedValue("transcript result");

    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-7",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-7",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 1_000,
      noOutputPollMs: 250,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    const texts = collectedTexts();
    expect(texts.some((text: string) => text.includes("has produced no output"))).toBe(false);
    expect(texts.some((text: string) => text.includes("run completed"))).toBe(true);
    relay.dispose();
  });
});
