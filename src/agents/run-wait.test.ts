/**
 * Regression coverage for gateway-backed agent run waiting.
 * Exercises timeout normalization, reply snapshots, and dynamic drain loops.
 */
import {
  addTimerTimeoutGraceMs,
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import {
  isRecoverableAgentWaitError,
  waitForAgentRun,
  waitForAgentRunsToDrain,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "./run-wait.js";

type AgentWaitGatewayRequest = {
  method?: string;
  params?: {
    offset?: number;
    runId?: string;
    timeoutMs?: unknown;
  };
  timeoutMs?: unknown;
};

function expectNumber(value: unknown, label: string): number {
  expect(typeof value).toBe("number");
  if (typeof value !== "number") {
    throw new Error(`expected ${label} to be a number`);
  }
  return value;
}

function gatewayWaitRequests(): AgentWaitGatewayRequest[] {
  return callGatewayMock.mock.calls.map(([request]) => request as AgentWaitGatewayRequest);
}

function createRunTurnBoundary(runId: string, seq = 1) {
  return {
    role: "user",
    content: [{ type: "text", text: "run input" }],
    __openclaw: { idempotencyKey: `${runId}:user`, seq },
  };
}

function requireRequestAt(
  requests: readonly AgentWaitGatewayRequest[],
  index: number,
): AgentWaitGatewayRequest {
  const request = requests.at(index);
  if (!request) {
    throw new Error(`expected gateway request at index ${index}`);
  }
  return request;
}

function expectAgentWaitRequest(
  request: AgentWaitGatewayRequest,
  runId: string,
  maxParamTimeoutMs: number,
): void {
  expect(request.method).toBe("agent.wait");
  expect(request.params?.runId).toBe(runId);

  const paramTimeoutMs = expectNumber(request.params?.timeoutMs, `${runId} param timeoutMs`);
  const requestTimeoutMs = expectNumber(request.timeoutMs, `${runId} request timeoutMs`);
  expect(requestTimeoutMs).toBe(addTimerTimeoutGraceMs(paramTimeoutMs, 2_000));
  expect(requestTimeoutMs).toBeLessThanOrEqual(
    addTimerTimeoutGraceMs(maxParamTimeoutMs, 2_000) ?? MAX_TIMER_TIMEOUT_MS,
  );
  expect(paramTimeoutMs).toBeGreaterThanOrEqual(1);
  expect(paramTimeoutMs).toBeLessThanOrEqual(maxParamTimeoutMs);
}

describe("waitForAgentRun", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("maps gateway timeouts to timeout status", async () => {
    callGatewayMock.mockRejectedValue(new Error("gateway timeout while waiting"));

    const result = await waitForAgentRun({ runId: "run-1", timeoutMs: 500 });

    expect(result).toEqual({
      status: "timeout",
      error: "gateway timeout while waiting",
    });
  });

  it("keeps transport-close wait failures as errors for generic callers", async () => {
    callGatewayMock.mockRejectedValue(new Error("gateway closed (1006): transport close"));

    const result = await waitForAgentRun({ runId: "run-interrupted", timeoutMs: 500 });

    expect(result).toEqual({
      status: "error",
      error: "gateway closed (1006): transport close",
    });
    expect(isRecoverableAgentWaitError(result.error)).toBe(true);
  });

  it("preserves pending agent.wait status", async () => {
    callGatewayMock.mockResolvedValue({ status: "pending" });

    const result = await waitForAgentRun({ runId: "run-pending", timeoutMs: 500 });

    expect(result).toEqual({ status: "pending" });
  });

  it("preserves pending error diagnostics on wait timeouts", async () => {
    callGatewayMock.mockResolvedValue({
      status: "timeout",
      error: "429 RESOURCE_EXHAUSTED",
      pendingError: true,
    });

    const result = await waitForAgentRun({ runId: "run-pending-error", timeoutMs: 500 });

    expect(result).toEqual({
      status: "timeout",
      error: "429 RESOURCE_EXHAUSTED",
      pendingError: true,
    });
  });

  it("normalizes wait timeouts before sending agent.wait", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const result = await waitForAgentRun({ runId: "run-clamped", timeoutMs: 0.8 });

    expect(result).toEqual({ status: "ok" });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "agent.wait",
      params: {
        runId: "run-clamped",
        timeoutMs: 1,
      },
      timeoutMs: 2_001,
    });
  });

  it("defaults non-finite wait timeouts before sending agent.wait", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const result = await waitForAgentRun({ runId: "run-nan", timeoutMs: Number.NaN });

    expect(result).toEqual({ status: "ok" });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "agent.wait",
      params: {
        runId: "run-nan",
        timeoutMs: 1,
      },
      timeoutMs: 2_001,
    });
  });

  it("caps oversized wait timeouts before sending agent.wait", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const result = await waitForAgentRun({
      runId: "run-huge",
      timeoutMs: Number.MAX_VALUE,
    });

    expect(result).toEqual({ status: "ok" });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "agent.wait",
      params: {
        runId: "run-huge",
        timeoutMs: MAX_TIMER_TIMEOUT_MS,
      },
      timeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
  });

  it("preserves timing metadata on provider-attributed wait timeouts", async () => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      timeoutPhase: "provider",
      providerStarted: true,
    });

    const result = await waitForAgentRun({ runId: "run-2", timeoutMs: 500 });

    expect(result).toEqual({
      status: "timeout",
      startedAt: 100,
      endedAt: 200,
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("keeps hard wait timeouts stronger than blocked liveness", async () => {
    callGatewayMock.mockResolvedValue({
      status: "error",
      error: "model timed out",
      livenessState: "blocked",
      timeoutPhase: "provider",
      providerStarted: true,
    });

    const result = await waitForAgentRun({ runId: "run-blocked-timeout", timeoutMs: 500 });

    expect(result).toEqual({
      status: "timeout",
      error: "model timed out",
      livenessState: "blocked",
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("normalizes blocked ok waits to errors", async () => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      livenessState: "blocked",
      error: "Context overflow: prompt too large for the model.",
    });

    const result = await waitForAgentRun({ runId: "run-blocked", timeoutMs: 500 });

    expect(result).toEqual({
      status: "error",
      error: "Context overflow: prompt too large for the model.",
      startedAt: 100,
      endedAt: 200,
      livenessState: "blocked",
    });
  });

  it("normalizes aborted stop reasons to errors even when gateway reports ok", async () => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      stopReason: "aborted",
    });

    const result = await waitForAgentRun({ runId: "run-aborted", timeoutMs: 500 });

    expect(result).toEqual({
      status: "error",
      error: "agent run aborted",
      startedAt: 100,
      endedAt: 200,
      stopReason: "aborted",
    });
  });
});

describe("waitForAgentRunAndReadUpdatedAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("returns undefined when the latest assistant fingerprint matches the baseline", async () => {
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "same reply" }],
      timestamp: 42,
    };
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
      })
      .mockResolvedValueOnce({
        messages: [createRunTurnBoundary("run-1"), assistantMessage],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-1",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
      baseline: {
        text: "same reply",
        fingerprint: JSON.stringify(assistantMessage),
      },
    });

    expect(result).toEqual({
      status: "ok",
      replyText: undefined,
    });
  });

  it("returns undefined when a text-only baseline matches the latest assistant reply", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
      })
      .mockResolvedValueOnce({
        messages: [
          createRunTurnBoundary("run-text-baseline"),
          {
            role: "assistant",
            content: [{ type: "text", text: "same reply" }],
            timestamp: 42,
          },
        ],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-text-baseline",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
      baseline: {
        text: "same reply",
      },
    });

    expect(result).toEqual({
      status: "ok",
      replyText: undefined,
    });
  });

  it("does not treat a message-tool delivery mirror as a new waited reply", async () => {
    const baselineMessage = {
      role: "assistant",
      content: [{ type: "text", text: "previous real reply" }],
      timestamp: 41,
    };
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
      })
      .mockResolvedValueOnce({
        messages: [
          baselineMessage,
          createRunTurnBoundary("run-source-reply"),
          {
            role: "assistant",
            provider: "openclaw",
            model: "delivery-mirror",
            content: [{ type: "text", text: "already delivered source reply" }],
            timestamp: 42,
          },
        ],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-source-reply",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
      baseline: {
        text: "previous real reply",
        fingerprint: JSON.stringify(baselineMessage),
      },
    });

    expect(result).toEqual({
      status: "ok",
      replyText: undefined,
    });
  });

  it("does not treat a projected message-tool mirror as a new waited reply", async () => {
    const baselineMessage = {
      role: "assistant",
      content: [{ type: "text", text: "previous real reply" }],
      timestamp: 41,
    };
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
      })
      .mockResolvedValueOnce({
        messages: [
          baselineMessage,
          createRunTurnBoundary("run-projected-source-reply"),
          {
            role: "assistant",
            content: [{ type: "text", text: "already delivered source reply" }],
            openclawMessageToolMirror: {
              toolName: "message",
              toolCallId: "call-message-send",
            },
            timestamp: 42,
          },
        ],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-projected-source-reply",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
      baseline: {
        text: "previous real reply",
        fingerprint: JSON.stringify(baselineMessage),
      },
    });

    expect(result).toEqual({
      status: "ok",
      replyText: undefined,
    });
  });

  it("returns a projected message-tool reply held for outer A2A delivery", async () => {
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }).mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:source",
            sourceTool: "sessions_send",
          },
          content: [{ type: "text", text: "forwarded request" }],
          __openclaw: { idempotencyKey: "run-internal-source-reply:user", seq: 41 },
          timestamp: 41,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "source reply awaiting delivery" }],
          openclawMessageToolMirror: {
            toolName: "message",
            toolCallId: "call-message-send",
            sourceReplySink: "internal-ui",
            sourceMessageSeq: 42,
          },
          timestamp: 42,
        },
      ],
    });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-internal-source-reply",
      sessionKey: "agent:worker:main",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: "ok",
      replyText: "source reply awaiting delivery",
    });
  });

  it("prefers an internal source reply over a later private final", async () => {
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }).mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:source",
            sourceTool: "sessions_send",
          },
          content: [{ type: "text", text: "forwarded request" }],
          __openclaw: {
            idempotencyKey: "run-internal-source-reply-with-private-final:user",
            seq: 41,
          },
          timestamp: 41,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "source reply awaiting delivery" }],
          openclawMessageToolMirror: {
            toolName: "message",
            toolCallId: "call-message-send",
            sourceReplySink: "internal-ui",
            sourceMessageSeq: 42,
          },
          timestamp: 42,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          timestamp: 43,
        },
      ],
    });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-internal-source-reply-with-private-final",
      sessionKey: "agent:worker:main",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: "ok",
      replyText: "source reply awaiting delivery",
    });
  });

  it("does not let a late internal result cross an inter-session turn boundary", async () => {
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }).mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:source",
            sourceTool: "sessions_send",
          },
          content: [{ type: "text", text: "new forwarded request" }],
          __openclaw: {
            idempotencyKey: "run-after-late-internal-source-reply:user",
            seq: 42,
          },
          timestamp: 42,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "stale source reply" }],
          openclawMessageToolMirror: {
            toolName: "message",
            toolCallId: "call-message-before-request",
            sourceReplySink: "internal-ui",
            sourceMessageSeq: 41,
          },
          timestamp: 41,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "fresh reply" }],
          timestamp: 43,
        },
      ],
    });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-after-late-internal-source-reply",
      sessionKey: "agent:worker:main",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: "ok",
      replyText: "fresh reply",
    });
  });

  it("does not return a private final written after a message-tool delivery mirror", async () => {
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }).mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:source",
            sourceTool: "sessions_send",
          },
          content: [{ type: "text", text: "forwarded request" }],
          __openclaw: {
            idempotencyKey: "run-source-reply-with-private-final:user",
            seq: 41,
          },
          timestamp: 41,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "already delivered source reply" }],
          openclawMessageToolMirror: {
            toolName: "message",
            toolCallId: "call-message-send",
          },
          timestamp: 42,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          timestamp: 43,
        },
      ],
    });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-source-reply-with-private-final",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: "ok",
      replyText: undefined,
    });
  });

  it("does not let an older turn's message-tool mirror suppress a fresh reply", async () => {
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }).mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "older delivered reply" }],
          openclawMessageToolMirror: {
            toolName: "message",
            toolCallId: "call-older-message-send",
          },
          timestamp: 40,
        },
        {
          role: "assistant",
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:source",
            sourceTool: "sessions_send",
          },
          content: [{ type: "text", text: "new forwarded request" }],
          __openclaw: { idempotencyKey: "run-after-older-source-reply:user", seq: 41 },
          timestamp: 41,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "fresh reply" }],
          timestamp: 42,
        },
      ],
    });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-after-older-source-reply",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: "ok",
      replyText: "fresh reply",
    });
  });

  it("does not resurrect an older reply when only a delivery mirror is newer", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
      })
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "stale previous reply" }],
            timestamp: 41,
          },
          createRunTurnBoundary("run-source-reply-without-baseline", 42),
          {
            role: "assistant",
            provider: "openclaw",
            model: "delivery-mirror",
            content: [{ type: "text", text: "already delivered source reply" }],
            timestamp: 42,
          },
        ],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-source-reply-without-baseline",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: "ok",
      replyText: undefined,
    });
  });

  it("returns the new assistant text when the fingerprint changes", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
      })
      .mockResolvedValueOnce({
        messages: [
          createRunTurnBoundary("run-2"),
          {
            role: "assistant",
            content: [{ type: "text", text: "fresh reply" }],
            timestamp: 99,
          },
        ],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-2",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
      baseline: {
        text: "older reply",
        fingerprint: "old-fingerprint",
      },
    });

    expect(result).toEqual({
      status: "ok",
      replyText: "fresh reply",
    });
  });

  it("preserves successful wait metadata when returning an updated reply", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        stopReason: "completed",
        yielded: true,
        providerStarted: true,
      })
      .mockResolvedValueOnce({
        messages: [
          createRunTurnBoundary("run-with-metadata"),
          {
            role: "assistant",
            content: [{ type: "text", text: "fresh reply" }],
            timestamp: 99,
          },
        ],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-with-metadata",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
      baseline: {
        text: "older reply",
        fingerprint: "old-fingerprint",
      },
    });

    expect(result).toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      stopReason: "completed",
      yielded: true,
      providerStarted: true,
      replyText: "fresh reply",
    });
  });

  it("does not return a newer concurrent run's reply", async () => {
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }).mockResolvedValueOnce({
      messages: [
        createRunTurnBoundary("run-awaited", 40),
        {
          role: "assistant",
          content: [{ type: "text", text: "awaited reply" }],
          __openclaw: { seq: 41 },
        },
        createRunTurnBoundary("run-concurrent", 42),
        {
          role: "assistant",
          content: [{ type: "text", text: "newer unrelated reply" }],
          __openclaw: { seq: 43 },
        },
      ],
    });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-awaited",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ status: "ok", replyText: "awaited reply" });
  });

  it("does not start history lookup after agent.wait consumes the reply deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      callGatewayMock.mockImplementation(async (request: AgentWaitGatewayRequest) => {
        if (request.method === "agent.wait") {
          vi.setSystemTime(2_001);
          return { status: "ok" };
        }
        throw new Error(`unexpected method: ${String(request.method)}`);
      });

      const result = await waitForAgentRunAndReadUpdatedAssistantReply({
        runId: "run-deadline-exhausted",
        sessionKey: "agent:main:child",
        timeoutMs: 1_000,
      });

      expect(result).toEqual({ status: "ok", replyText: undefined });
      expect(callGatewayMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hanging history page by the remaining agent.wait deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let historyPage = 0;
      callGatewayMock.mockImplementation((request: AgentWaitGatewayRequest) => {
        if (request.method === "agent.wait") {
          vi.setSystemTime(1_500);
          return Promise.resolve({ status: "ok" });
        }
        if (request.method !== "chat.history") {
          return Promise.reject(new Error(`unexpected method: ${String(request.method)}`));
        }
        const timeoutMs = expectNumber(request.timeoutMs, "chat.history timeoutMs");
        historyPage += 1;
        if (historyPage === 1) {
          expect(timeoutMs).toBe(500);
          vi.setSystemTime(1_750);
          return Promise.resolve({
            messages: [],
            hasMore: true,
            nextOffset: 1,
            totalMessages: 2,
          });
        }
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error("gateway timeout while reading history")), timeoutMs);
        });
      });

      const resultPromise = waitForAgentRunAndReadUpdatedAssistantReply({
        runId: "run-hanging-history",
        sessionKey: "agent:main:child",
        timeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(0);

      const historyRequest = requireRequestAt(gatewayWaitRequests(), 2);
      expect(historyRequest.method).toBe("chat.history");
      expect(historyRequest.params?.offset).toBe(1);
      expect(historyRequest.timeoutMs).toBe(250);

      await vi.advanceTimersByTimeAsync(250);
      await expect(resultPromise).resolves.toEqual({ status: "ok", replyText: undefined });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("waitForAgentRunsToDrain", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("waits across rounds until descendant runs stop changing", async () => {
    let activeRunIds = ["run-1"];
    callGatewayMock.mockImplementation(async (opts) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method !== "agent.wait") {
        throw new Error(`unexpected method: ${String(request.method)}`);
      }
      if (request.params?.runId === "run-1") {
        activeRunIds = ["run-2"];
      } else if (request.params?.runId === "run-2") {
        activeRunIds = [];
      }
      return { status: "ok" };
    });

    const result = await waitForAgentRunsToDrain({
      timeoutMs: 1_000,
      getPendingRunIds: () => activeRunIds,
    });

    expect(result.timedOut).toBe(false);
    expect(result.pendingRunIds).toStrictEqual([]);
    expectNumber(result.deadlineAtMs, "deadlineAtMs");

    const requests = gatewayWaitRequests();
    expect(requests).toHaveLength(2);
    expectAgentWaitRequest(requireRequestAt(requests, 0), "run-1", 1_000);
    expectAgentWaitRequest(requireRequestAt(requests, 1), "run-2", 1_000);
  });

  it("deduplicates and trims pending run ids", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = [" run-1 ", "run-1", "", "run-2"];

    const result = await waitForAgentRunsToDrain({
      timeoutMs: 1_000,
      getPendingRunIds: () => {
        const current = activeRunIds;
        activeRunIds = [];
        return current;
      },
    });

    expect(result.timedOut).toBe(false);
    expect(callGatewayMock.mock.calls).toHaveLength(2);
  });

  it("keeps the initial pending run ids before refreshing", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = ["run-2"];

    const result = await waitForAgentRunsToDrain({
      timeoutMs: 1_000,
      initialPendingRunIds: ["run-1"],
      getPendingRunIds: () => {
        const current = activeRunIds;
        activeRunIds = [];
        return current;
      },
    });

    expect(result.timedOut).toBe(false);
    const requests = gatewayWaitRequests();
    expect(requests).toHaveLength(2);
    expectAgentWaitRequest(requireRequestAt(requests, 0), "run-1", 1_000);
    expectAgentWaitRequest(requireRequestAt(requests, 1), "run-2", 1_000);
  });

  it("defaults non-finite drain timeouts before computing the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T00:00:00Z"));
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = ["run-1"];

    try {
      const result = await waitForAgentRunsToDrain({
        timeoutMs: Number.NaN,
        getPendingRunIds: () => {
          const current = activeRunIds;
          activeRunIds = [];
          return current;
        },
      });

      expect(result.timedOut).toBe(false);
      expect(Number.isFinite(result.deadlineAtMs)).toBe(true);
      expectAgentWaitRequest(requireRequestAt(gatewayWaitRequests(), 0), "run-1", 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out immediately when the computed drain deadline exceeds the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));
    try {
      const result = await waitForAgentRunsToDrain({
        timeoutMs: 1,
        getPendingRunIds: () => ["run-1"],
      });

      expect(result).toEqual({
        timedOut: true,
        pendingRunIds: ["run-1"],
        deadlineAtMs: MAX_DATE_TIMESTAMP_MS,
      });
      expect(callGatewayMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores invalid caller-supplied drain deadlines", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T00:00:00Z"));
    try {
      const result = await waitForAgentRunsToDrain({
        deadlineAtMs: Number.POSITIVE_INFINITY,
        getPendingRunIds: () => ["run-1"],
      });

      expect(result.timedOut).toBe(true);
      expect(result.pendingRunIds).toStrictEqual(["run-1"]);
      expect(result.deadlineAtMs).toBe(Date.now());
      expect(callGatewayMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isRecoverableAgentWaitError", () => {
  it.each([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
  ])("recovers from %s connection failures", (code) => {
    expect(isRecoverableAgentWaitError(`connect ${code} 127.0.0.1:443`)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "gateway timeout",
    "ENOENT: no such file",
    "getaddrinfo ENOTFOUND gateway.example.com",
  ])("does not recover from %s", (error) => {
    expect(isRecoverableAgentWaitError(error)).toBe(false);
  });
});
