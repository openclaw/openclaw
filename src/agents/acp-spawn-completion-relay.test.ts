import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { startAcpSpawnCompletionRelay } from "./acp-spawn-completion-relay.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const captureSubagentCompletionReplyMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: (...args: unknown[]) =>
    captureSubagentCompletionReplyMock(...args),
}));

function collectedTexts() {
  return enqueueSystemEventMock.mock.calls.map((call) => String(call[0] ?? ""));
}

describe("startAcpSpawnCompletionRelay", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    captureSubagentCompletionReplyMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("relays captured completion text back to the parent session", async () => {
    captureSubagentCompletionReplyMock.mockResolvedValue("Final answer from child");
    const relay = startAcpSpawnCompletionRelay({
      runId: "run-1",
      parentSessionKey: "agent:main:telegram:direct:123",
      childSessionKey: "agent:codex:acp:child-1",
      agentId: "codex",
    });

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await vi.runAllTimersAsync();

    expect(captureSubagentCompletionReplyMock).toHaveBeenCalledWith("agent:codex:acp:child-1");
    expect(collectedTexts().some((text) => text.includes("codex completed:"))).toBe(true);
    expect(collectedTexts().some((text) => text.includes("Final answer from child"))).toBe(true);
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "acp:spawn:completion",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
    relay.dispose();
  });

  it("reports lifecycle errors to the parent session", () => {
    const relay = startAcpSpawnCompletionRelay({
      runId: "run-2",
      parentSessionKey: "agent:main:telegram:direct:123",
      childSessionKey: "agent:codex:acp:child-2",
      agentId: "codex",
    });

    emitAgentEvent({
      runId: "run-2",
      stream: "lifecycle",
      data: { phase: "error", error: "boom", startedAt: 1_000, endedAt: 3_000 },
    });

    expect(collectedTexts().some((text) => text.includes("codex failed after 2s: boom"))).toBe(
      true,
    );
    expect(captureSubagentCompletionReplyMock).not.toHaveBeenCalled();
    relay.dispose();
  });
});
