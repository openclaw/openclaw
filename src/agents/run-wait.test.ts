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
import { GatewayProtocolRequestError } from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import * as gatewayCallRuntime from "../gateway/call.js";
import { GatewayDispatchUnavailableError } from "../infra/restart-recovery-errors.js";
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

beforeEach(() => callGatewayMock.mockReset());

const sessionKey = "agent:main:child";
const readReply = () => readLatestAssistantReply({ sessionKey });
const wait = (runId = "run-observed") => waitForAgentRun({ runId, timeoutMs: 500 });
const observe = (untilTerminal?: true) =>
  waitForAgentRunReply({ runId: "run-ended", timeoutMs: 1_000, untilTerminal });

async function expectHistoryReply(messages: unknown[], expected: string) {
  callGatewayMock.mockResolvedValue({ messages });
  await expect(readReply()).resolves.toBe(expected);
}
function signedText(text: string, id: string, phase: string) {
  return { type: "text", text, textSignature: JSON.stringify({ v: 1, id, phase }) };
}
function mockCappedLookup(lookup: () => { ok: true; message: ReturnType<typeof textAssistant> }) {
  callGatewayMock.mockImplementation(async (request) =>
    request.method === "chat.history"
      ? {
          messages: [
            {
              ...textAssistant("Report head\n...(truncated)..."),
              __openclaw: { id: "msg-1", truncated: true, reason: "display-cap" },
            },
          ],
        }
      : lookup(),
  );
}

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
  it("returns the most recent assistant message when compaction markers trail history", async () => {
    await expectHistoryReply(
      [
        textAssistant("All checks passed and changes were pushed."),
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
      "All checks passed and changes were pushed.",
    );
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey, limit: 50 },
    });
  });

  it("falls back to older assistant text when latest assistant has no text", async () => {
    await expectHistoryReply(
      [
        textAssistant("older output"),
        { role: "assistant", content: [] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
      "older output",
    );
  });

  it("skips trailing transcript-only OpenClaw assistant mirrors for normal latest-reply reads", async () => {
    await expectHistoryReply(
      [
        { ...textAssistant("real worker reply"), timestamp: 10 },
        {
          ...textAssistant("already delivered through message tool"),
          openclawMessageToolMirror: { toolName: "message", toolCallId: "call-message-send" },
          timestamp: 11,
        },
        {
          ...textAssistant("gateway notice"),
          provider: "openclaw",
          model: "gateway-injected",
          timestamp: 12,
        },
      ],
      "real worker reply",
    );
  });

  it("skips a trailing projected cron run prompt for latest-reply reads", async () => {
    await expectHistoryReply(
      [
        { ...textAssistant("older worker reply"), timestamp: 10 },
        {
          ...textAssistant("forwarded input text"),
          timestamp: 11,
          provenance: {
            kind: "internal_system",
            sourceTool: "cron",
            jobId: "job-1",
            runId: "run-1",
            sourceSessionKey: "agent:main:cron:job-1:run:run-1",
          },
        },
      ],
      "older worker reply",
    );
  });

  it("preserves spaces across split final_answer history blocks", async () => {
    await expectHistoryReply(
      [
        {
          role: "assistant",
          content: [
            signedText("Need fix line quoting properly.", "commentary", "commentary"),
            signedText("Hi ", "final_1", "final_answer"),
            signedText("there", "final_2", "final_answer"),
          ],
        },
      ],
      "Hi there",
    );
  });

  it("reads the full message when history returns a display-capped preview", async () => {
    mockCappedLookup(() => ({
      ok: true,
      message: textAssistant("Report head and the full remainder."),
    }));

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
    mockCappedLookup(() => {
      throw new Error("session changed while reading history; reload the conversation");
    });
    await expect(readReply()).resolves.toBeUndefined();
  });
});

describe("waitForAgentRun", () => {
  it("preserves pending error diagnostics on wait timeouts", async () => {
    const response = { status: "timeout", error: "429 RESOURCE_EXHAUSTED", pendingError: true };
    callGatewayMock.mockResolvedValue(response);
    await expect(wait()).resolves.toEqual(response);
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

    const result = await wait("run-source-reply");

    expect(result.sourceReplyDelivered).toBe(entry.expected);
  });

  it.each(["gateway-restarting", "gateway-suspending", undefined])(
    "keeps a %s observation refusal retryable without reclassifying terminal run text",
    async (reason) => {
      const message = "agent.wait unavailable during gateway maintenance";
      callGatewayMock.mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message,
          retryable: true,
          ...(reason ? { details: { reason } } : {}),
        }),
      );
      expect(await wait("running-child")).toEqual({
        status: "error",
        error: message,
        retryableTransportError: true,
      });
      callGatewayMock.mockResolvedValueOnce({
        status: "error",
        error: message,
        startedAt: 100,
        endedAt: 200,
      });
      const terminal = await wait("failed-child");
      expect(terminal).toMatchObject({
        status: "error",
        error: message,
        endedAt: 200,
      });
      expect(terminal.retryableTransportError).toBeUndefined();
    },
  );

  it.each([
    {
      name: "a protocol observation refusal",
      draining: false,
      cause: new GatewayProtocolRequestError({
        code: "UNAVAILABLE",
        message: "agent.wait unavailable during gateway suspension",
        retryable: true,
      }),
      retryable: true,
    },
    {
      name: "a closed instance's refusal during restart drain",
      draining: true,
      cause: new GatewayDispatchUnavailableError("agent.wait", false),
      retryable: true,
    },
    {
      name: "a closed instance's refusal outside restart drain",
      draining: false,
      cause: new GatewayDispatchUnavailableError("agent.wait", false),
      retryable: false,
    },
  ])("classifies $name without inferring a terminal run", async (entry) => {
    resetGatewayWorkAdmission();
    if (entry.draining) {
      markGatewayRestartDraining("stop (SIGTERM)");
    }
    try {
      callGatewayMock.mockRejectedValueOnce(entry.cause);
      const result = await wait();
      expect(result.status).toBe("error");
      expect(result.error).toBe(entry.cause.message);
      expect(result.retryableTransportError).toBe(entry.retryable ? true : undefined);
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it.each([
    {
      fields: {
        livenessState: "blocked",
        error: "Context overflow: prompt too large for the model.",
      },
      error: "Context overflow: prompt too large for the model.",
    },
    { fields: { stopReason: "aborted" }, error: "agent run aborted" },
  ])("normalizes an ok wait with $fields to an error", async ({ fields, error }) => {
    callGatewayMock.mockResolvedValue({ status: "ok", startedAt: 100, endedAt: 200, ...fields });
    await expect(wait()).resolves.toEqual({
      ...fields,
      status: "error",
      error,
      startedAt: 100,
      endedAt: 200,
    });
  });
});

describe("waitForAgentRunReply", () => {
  it("returns the run's reply and metadata without consulting unrelated session history", async () => {
    const response = {
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      stopReason: "completed",
      yielded: true,
      providerStarted: true,
      terminalReply: { disposition: "visible", text: "authoritative reply" },
    };
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error("session history is not delivery evidence");
      }
      return response;
    });
    await expect(observe()).resolves.toEqual({ ...response, replyText: "authoritative reply" });
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

    const result = await observe();

    expect(result).toEqual({ status: "ok", terminalReply });
    expect(result.replyText).toBeUndefined();
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(["agent.wait"]);
  });

  it.each([
    { status: "timeout", timeoutPhase: "preflight" },
    { status: "error", endedAt: 200, stopReason: "aborted", error: "cancelled" },
  ])("ends completion observation for $status / $stopReason", async (terminal) => {
    callGatewayMock.mockResolvedValue(terminal);

    const result = await observe(true);

    expect(result).toMatchObject(terminal);
    expect(result.replyText).toBeUndefined();
    expect(callGatewayMock).toHaveBeenCalledOnce();
  });

  it.each(["gateway closed (1006)", "gateway request timeout"])(
    "does not retain completion observation after transport failure: %s",
    async (message) => {
      callGatewayMock.mockRejectedValue(new Error(message));

      const result = await observe(true);

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
      const observation = work.run(() => observe(true));
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
  it.each(["ok"])(
    "lets completion callbacks drain runs after immediate %s responses",
    async (status) => {
      callGatewayMock.mockResolvedValue({ status });
      let activeRunIds = ["run-1"];
      const completion = setTimeout(() => {
        activeRunIds = [];
      }, 0);
      try {
        await waitForAgentRunsToDrain({
          timeoutMs: 200,
          getPendingRunIds: async () => activeRunIds,
        });

        expect(activeRunIds).toEqual([]);
        expect(callGatewayMock).toHaveBeenCalled();
        expect(callGatewayMock.mock.calls.length).toBeLessThanOrEqual(4);
      } finally {
        clearTimeout(completion);
      }
    },
  );

  it("bounds retries of unchanged runs by the drain deadline", async () => {
    callGatewayMock.mockResolvedValue({ status: "pending" });
    const deadlineAtMs = Date.now() + 150;

    await waitForAgentRunsToDrain({
      deadlineAtMs,
      getPendingRunIds: async () => ["run-1"],
    });

    expect(Date.now()).toBeGreaterThanOrEqual(deadlineAtMs);
    expect(callGatewayMock.mock.calls.length).toBeLessThanOrEqual(4);
    expectAgentWaitRequest(requireRequestAt(gatewayWaitRequests(), 0), "run-1", 150);
  });

  it("keeps the initial pending run ids before refreshing", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = ["run-2"];

    await waitForAgentRunsToDrain({
      timeoutMs: 1_000,
      initialPendingRunIds: ["run-1"],
      getPendingRunIds: async () => {
        const current = activeRunIds;
        activeRunIds = [];
        return current;
      },
    });

    expect(activeRunIds).toEqual([]);
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
      await waitForAgentRunsToDrain({
        timeoutMs: Number.NaN,
        getPendingRunIds: async () => {
          const current = activeRunIds;
          activeRunIds = [];
          return current;
        },
      });

      expect(activeRunIds).toEqual([]);
      expectAgentWaitRequest(requireRequestAt(gatewayWaitRequests(), 0), "run-1", 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out immediately when the computed drain deadline exceeds the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));
    try {
      await waitForAgentRunsToDrain({
        timeoutMs: 1,
        getPendingRunIds: async () => ["run-1"],
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
      await waitForAgentRunsToDrain({
        deadlineAtMs: Number.POSITIVE_INFINITY,
        getPendingRunIds: async () => ["run-1"],
      });

      expect(callGatewayMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
