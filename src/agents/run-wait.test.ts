/**
 * Regression coverage for gateway-backed agent run waiting.
 * Exercises timeout normalization, run-owned replies, and dynamic drain loops.
 */
import {
  addTimerTimeoutGraceMs,
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayCallRuntime from "../gateway/call.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
const callGatewayMock = vi.spyOn(gatewayCallRuntime, "callGateway");
afterAll(() => callGatewayMock.mockRestore());

import {
  readLatestAssistantReply,
  waitForAgentRun,
  waitForAgentRunsToDrain,
  waitForAgentRunReply,
} from "./run-wait.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

type AgentWaitGatewayRequest = {
  method?: string;
  params?: {
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

describe("readLatestAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("returns the most recent assistant message when compaction markers trail history", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        textAssistant("All checks passed and changes were pushed."),
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("All checks passed and changes were pushed.");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:child", limit: 50 },
    });
  });

  it("falls back to older assistant text when latest assistant has no text", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "older output" }] },
        { role: "assistant", content: [] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("older output");
  });

  it("skips trailing transcript-only OpenClaw assistant mirrors for normal latest-reply reads", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "real worker reply" }],
          timestamp: 10,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "already delivered through message tool" }],
          openclawMessageToolMirror: {
            toolName: "message",
            toolCallId: "call-message-send",
          },
          timestamp: 11,
        },
        {
          role: "assistant",
          provider: "openclaw",
          model: "gateway-injected",
          content: [{ type: "text", text: "gateway notice" }],
          timestamp: 12,
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("real worker reply");
  });

  it.each([
    {
      name: "cron run prompt",
      provenance: {
        kind: "internal_system",
        sourceTool: "cron",
        jobId: "job-1",
        runId: "run-1",
        sourceSessionKey: "agent:main:cron:job-1:run:run-1",
      },
    },
  ])("skips a trailing projected $name for latest-reply reads", async ({ provenance }) => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "older worker reply" }],
          timestamp: 10,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "forwarded input text" }],
          provenance,
          timestamp: 11,
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:target" });

    expect(result).toBe("older worker reply");
  });

  it("preserves spaces across split final_answer history blocks", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Need fix line quoting properly.",
              textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
            },
            {
              type: "text",
              text: "Hi ",
              textSignature: JSON.stringify({ v: 1, id: "final_1", phase: "final_answer" }),
            },
            {
              type: "text",
              text: "there",
              textSignature: JSON.stringify({ v: 1, id: "final_2", phase: "final_answer" }),
            },
          ],
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("Hi there");
  });

  it("reads the full message when history returns a display-capped preview", async () => {
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              ...textAssistant("Report head\n...(truncated)..."),
              __openclaw: { id: "msg-1", truncated: true, reason: "display-cap" },
            },
          ],
        };
      }
      return { ok: true, message: textAssistant("Report head and the full remainder.") };
    });

    const result = await readLatestAssistantReply({
      sessionKey: "agent:main:child",
      agentId: "main",
    });

    expect(result).toBe("Report head and the full remainder.");
    expect(callGatewayMock).toHaveBeenLastCalledWith({
      method: "chat.message.get",
      params: { sessionKey: "agent:main:child", agentId: "main", messageId: "msg-1" },
    });
  });

  it("returns no reply when the full-message lookup is rejected", async () => {
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              ...textAssistant("Report head\n...(truncated)..."),
              __openclaw: { id: "msg-1", truncated: true, reason: "display-cap" },
            },
          ],
        };
      }
      throw new Error("session changed while reading history; reload the conversation");
    });

    await expect(readLatestAssistantReply({ sessionKey: "agent:main:child" })).resolves.toBe(
      undefined,
    );
  });
});

describe("waitForAgentRun", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
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

  it.each([
    { name: "confirmed final source reply", sourceReplyDelivered: true, expected: true },
    { name: "non-boolean marker", sourceReplyDelivered: "true", expected: undefined },
    {
      name: "another run",
      sourceReplyDelivered: true,
      receiptRunId: "run-other",
      expected: undefined,
    },
  ])("accepts source delivery evidence only for the waited run: $name", async (entry) => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      terminalReceipt: {
        runId: entry.receiptRunId ?? "run-source-reply",
        sessionId: "session-source",
        turnId: "turn-source",
        requested: { provider: "openai", model: "gpt-5.6-luna" },
        effective: {
          provider: "openai",
          model: "gpt-5.6-luna",
          responseModel: "gpt-5.6-luna",
        },
        successfulToolNames: ["message"],
        rerouted: false,
        terminalDisposition: "visible",
        sourceReplyDelivered: entry.sourceReplyDelivered,
      },
    });

    const result = await waitForAgentRun({ runId: "run-source-reply", timeoutMs: 500 });

    expect(result.sourceReplyDelivered).toBe(entry.expected);
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

describe("waitForAgentRunReply", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("returns the run's reply and metadata without consulting unrelated session history", async () => {
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error("session history is not delivery evidence");
      }
      return {
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        stopReason: "completed",
        yielded: true,
        providerStarted: true,
        terminalReply: { disposition: "visible", text: "authoritative reply" },
      };
    });

    const result = await waitForAgentRunReply({
      runId: "run-visible-terminal-reply",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      stopReason: "completed",
      yielded: true,
      providerStarted: true,
      terminalReply: { disposition: "visible", text: "authoritative reply" },
      replyText: "authoritative reply",
    });
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(["agent.wait"]);
  });

  it.each([
    { name: "silent", terminalReply: { disposition: "silent" } },
    { name: "empty", terminalReply: { disposition: "empty" } },
  ])("does not resurrect history for a $name terminal reply", async ({ terminalReply }) => {
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error("history must not override terminal reply evidence");
      }
      return { status: "ok", terminalReply };
    });

    const result = await waitForAgentRunReply({ runId: "run-no-reply", timeoutMs: 1_000 });

    expect(result).toEqual({ status: "ok", terminalReply });
    expect(result.replyText).toBeUndefined();
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(["agent.wait"]);
  });

  it.each([
    { status: "timeout", timeoutPhase: "preflight" },
    { status: "error", endedAt: 200, stopReason: "aborted", error: "cancelled" },
  ])("ends completion observation for $status / $stopReason", async (terminal) => {
    callGatewayMock.mockResolvedValue(terminal);

    const result = await waitForAgentRunReply({
      runId: "run-ended",
      timeoutMs: 1_000,
      untilTerminal: true,
    });

    expect(result).toMatchObject(terminal);
    expect(result.replyText).toBeUndefined();
    expect(callGatewayMock).toHaveBeenCalledOnce();
  });

  it.each(["gateway closed (1006)", "gateway request timeout"])(
    "does not retain completion observation after transport failure: %s",
    async (message) => {
      callGatewayMock.mockRejectedValue(new Error(message));

      const result = await waitForAgentRunReply({
        runId: "run-disconnected",
        timeoutMs: 1_000,
        untilTerminal: true,
      });

      expect(result.error).toBe(message);
      expect(result.replyText).toBeUndefined();
      expect(callGatewayMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["work scope", "Gateway restart"])(
    "retires pending observation when its %s closes",
    async (owner) => {
      const work = new AsyncWorkScope();
      callGatewayMock.mockResolvedValue({ status: "pending", timeoutPhase: "queue" });
      const observation = work.run(() =>
        waitForAgentRunReply({
          runId: "run-queued",
          timeoutMs: 1_000,
          untilTerminal: true,
        }),
      );
      const rejection = expect(observation).rejects.toThrow();
      try {
        await vi.waitFor(() => expect(callGatewayMock).toHaveBeenCalledOnce());
        if (owner === "work scope") {
          work.beginClose(new Error("Gateway owner closed"));
        } else {
          markGatewayRestartDraining();
        }
        await rejection;
        expect(callGatewayMock).toHaveBeenCalledOnce();
      } finally {
        work.beginClose();
        resetGatewayWorkAdmission();
        await work.drain();
      }
    },
  );
});

describe("waitForAgentRunsToDrain", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it.each(["ok"])(
    "lets completion callbacks drain runs after immediate %s responses",
    async (status) => {
      callGatewayMock.mockResolvedValue({ status });
      let activeRunIds = ["run-1"];
      const completion = setTimeout(() => {
        activeRunIds = [];
      }, 0);
      try {
        const result = await waitForAgentRunsToDrain({
          timeoutMs: 200,
          getPendingRunIds: async () => activeRunIds,
        });

        expect(result.timedOut).toBe(false);
        expect(result.pendingRunIds).toEqual([]);
        expect(callGatewayMock.mock.calls.length).toBeLessThanOrEqual(4);
      } finally {
        clearTimeout(completion);
      }
    },
  );

  it("bounds retries of unchanged runs by the drain deadline", async () => {
    callGatewayMock.mockResolvedValue({ status: "pending" });
    const deadlineAtMs = Date.now() + 150;

    const result = await waitForAgentRunsToDrain({
      deadlineAtMs,
      getPendingRunIds: async () => ["run-1"],
    });

    expect(result).toEqual({ timedOut: true, pendingRunIds: ["run-1"], deadlineAtMs });
    expect(callGatewayMock.mock.calls.length).toBeLessThanOrEqual(4);
    expectAgentWaitRequest(requireRequestAt(gatewayWaitRequests(), 0), "run-1", 150);
  });

  it("keeps the initial pending run ids before refreshing", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = ["run-2"];

    const result = await waitForAgentRunsToDrain({
      timeoutMs: 1_000,
      initialPendingRunIds: ["run-1"],
      getPendingRunIds: async () => {
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
        getPendingRunIds: async () => {
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
        getPendingRunIds: async () => ["run-1"],
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
        getPendingRunIds: async () => ["run-1"],
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
