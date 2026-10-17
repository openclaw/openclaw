import {
  addTimerTimeoutGraceMs,
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import * as gatewayCallRuntime from "../gateway/call.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
const callGatewayMock = vi.spyOn(gatewayCallRuntime, "callGateway");
afterAll(() => callGatewayMock.mockRestore());
beforeEach(() => callGatewayMock.mockReset());

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

function expectAgentWaitRequest(index: number, runId: string, maxParamTimeoutMs: number): void {
  const request = callGatewayMock.mock.calls[index]?.[0] as AgentWaitGatewayRequest | undefined;
  expect(request).toMatchObject({ method: "agent.wait", params: { runId } });
  if (!request) {
    throw new Error(`expected gateway request at index ${index}`);
  }

  const paramTimeoutMs = expectNumber(request.params?.timeoutMs, `${runId} param timeoutMs`);
  const requestTimeoutMs = expectNumber(request.timeoutMs, `${runId} request timeoutMs`);
  expect(requestTimeoutMs).toBe(addTimerTimeoutGraceMs(paramTimeoutMs, 2_000));
  expect(requestTimeoutMs).toBeLessThanOrEqual(
    addTimerTimeoutGraceMs(maxParamTimeoutMs, 2_000) ?? MAX_TIMER_TIMEOUT_MS,
  );
  expect(paramTimeoutMs).toBeGreaterThanOrEqual(1);
  expect(paramTimeoutMs).toBeLessThanOrEqual(maxParamTimeoutMs);
}

function assistant(text: string, extra = {}) {
  return { role: "assistant", content: [{ type: "text", text }], ...extra };
}

const cappedMessage = {
  ...textAssistant("Report head\n...(truncated)..."),
  __openclaw: { id: "msg-1", truncated: true, reason: "display-cap" },
};

function expectLatestReply(messages: unknown[], expected: string, sessionKey = "agent:main:child") {
  callGatewayMock.mockResolvedValue({ messages });
  return expect(readLatestAssistantReply({ sessionKey })).resolves.toBe(expected);
}

function waitReply(runId: string, untilTerminal?: true) {
  return waitForAgentRunReply({ runId, timeoutMs: 1_000, untilTerminal });
}

async function withClock(at: number | string, run: () => Promise<void>) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

describe("readLatestAssistantReply", () => {
  it("returns the most recent assistant message when compaction markers trail history", async () => {
    await expectLatestReply(
      [
        textAssistant("All checks passed and changes were pushed."),
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
      "All checks passed and changes were pushed.",
    );
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:child", limit: 50 },
    });
  });

  it("falls back to older assistant text when latest assistant has no text", async () => {
    await expectLatestReply(
      [
        assistant("older output"),
        { role: "assistant", content: [] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
      "older output",
    );
  });

  it("skips trailing transcript-only OpenClaw assistant mirrors for normal latest-reply reads", async () => {
    await expectLatestReply(
      [
        assistant("real worker reply", { timestamp: 10 }),
        assistant("already delivered through message tool", {
          openclawMessageToolMirror: {
            toolName: "message",
            toolCallId: "call-message-send",
          },
          timestamp: 11,
        }),
        assistant("gateway notice", {
          provider: "openclaw",
          model: "gateway-injected",
          timestamp: 12,
        }),
      ],
      "real worker reply",
    );
  });

  it("skips a trailing projected cron run prompt for latest-reply reads", async () => {
    const provenance = {
      kind: "internal_system",
      sourceTool: "cron",
      jobId: "job-1",
      runId: "run-1",
      sourceSessionKey: "agent:main:cron:job-1:run:run-1",
    };
    await expectLatestReply(
      [
        assistant("older worker reply", { timestamp: 10 }),
        assistant("forwarded input text", { provenance, timestamp: 11 }),
      ],
      "older worker reply",
      "agent:main:target",
    );
  });

  it("preserves spaces across split final_answer history blocks", async () => {
    const block = (text: string, id: string, phase: string) => ({
      type: "text",
      text,
      textSignature: JSON.stringify({ v: 1, id, phase }),
    });
    await expectLatestReply(
      [
        {
          role: "assistant",
          content: [
            block("Need fix line quoting properly.", "commentary", "commentary"),
            block("Hi ", "final_1", "final_answer"),
            block("there", "final_2", "final_answer"),
          ],
        },
      ],
      "Hi there",
    );
  });

  it("reads the full message when history returns a display-capped preview", async () => {
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "chat.history") {
        return { messages: [cappedMessage] };
      }
      return { ok: true, message: textAssistant("Report head and the full remainder.") };
    });

    await expect(
      readLatestAssistantReply({
        sessionKey: "agent:main:child",
        agentId: "main",
      }),
    ).resolves.toBe("Report head and the full remainder.");
    expect(callGatewayMock).toHaveBeenLastCalledWith({
      method: "chat.message.get",
      params: { sessionKey: "agent:main:child", agentId: "main", messageId: "msg-1" },
    });
  });

  it("returns no reply when the full-message lookup is rejected", async () => {
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "chat.history") {
        return { messages: [cappedMessage] };
      }
      throw new Error("session changed while reading history; reload the conversation");
    });

    await expect(readLatestAssistantReply({ sessionKey: "agent:main:child" })).resolves.toBe(
      undefined,
    );
  });
});

describe("waitForAgentRun", () => {
  it("preserves pending error diagnostics on wait timeouts", async () => {
    callGatewayMock.mockResolvedValue({
      status: "timeout",
      error: "429 RESOURCE_EXHAUSTED",
      pendingError: true,
    });

    await expect(waitForAgentRun({ runId: "run-pending-error", timeoutMs: 500 })).resolves.toEqual({
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
      expect(await waitForAgentRun({ runId: "running-child", timeoutMs: 500 })).toEqual({
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
      const terminal = await waitForAgentRun({ runId: "failed-child", timeoutMs: 500 });
      expect(terminal).toMatchObject({
        status: "error",
        error: message,
        endedAt: 200,
      });
      expect(terminal.retryableTransportError).toBeUndefined();
    },
  );

  it("normalizes blocked ok waits to errors", async () => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      livenessState: "blocked",
      error: "Context overflow: prompt too large for the model.",
    });

    await expect(waitForAgentRun({ runId: "run-blocked", timeoutMs: 500 })).resolves.toEqual({
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

    await expect(waitForAgentRun({ runId: "run-aborted", timeoutMs: 500 })).resolves.toEqual({
      status: "error",
      error: "agent run aborted",
      startedAt: 100,
      endedAt: 200,
      stopReason: "aborted",
    });
  });
});

describe("waitForAgentRunReply", () => {
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

    await expect(waitReply("run-visible-terminal-reply")).resolves.toEqual({
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

    const result = await waitReply("run-no-reply");

    expect(result).toEqual({ status: "ok", terminalReply });
    expect(result.replyText).toBeUndefined();
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(["agent.wait"]);
  });

  it.each([
    { status: "timeout", timeoutPhase: "preflight" },
    { status: "error", endedAt: 200, stopReason: "aborted", error: "cancelled" },
  ])("ends completion observation for $status / $stopReason", async (terminal) => {
    callGatewayMock.mockResolvedValue(terminal);

    const result = await waitReply("run-ended", true);

    expect(result).toMatchObject(terminal);
    expect(result.replyText).toBeUndefined();
    expect(callGatewayMock).toHaveBeenCalledOnce();
  });

  it.each(["gateway closed (1006)", "gateway request timeout"])(
    "does not retain completion observation after transport failure: %s",
    async (message) => {
      callGatewayMock.mockRejectedValue(new Error(message));

      const result = await waitReply("run-disconnected", true);

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
      const observation = work.run(() => waitReply("run-queued", true));
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
  it("lets completion callbacks drain runs after immediate ok responses", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
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
  });

  it("bounds retries of unchanged runs by the drain deadline", async () => {
    callGatewayMock.mockResolvedValue({ status: "pending" });
    const deadlineAtMs = Date.now() + 150;

    const result = await waitForAgentRunsToDrain({
      deadlineAtMs,
      getPendingRunIds: async () => ["run-1"],
    });

    expect(result).toEqual({ timedOut: true, pendingRunIds: ["run-1"], deadlineAtMs });
    expect(callGatewayMock.mock.calls.length).toBeLessThanOrEqual(4);
    expectAgentWaitRequest(0, "run-1", 150);
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
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expectAgentWaitRequest(0, "run-1", 1_000);
    expectAgentWaitRequest(1, "run-2", 1_000);
  });

  it("defaults non-finite drain timeouts before computing the deadline", () =>
    withClock("2026-05-30T00:00:00Z", async () => {
      callGatewayMock.mockResolvedValue({ status: "ok" });
      let activeRunIds = ["run-1"];

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
      expectAgentWaitRequest(0, "run-1", 1);
    }));

  it("times out immediately when the computed drain deadline exceeds the Date range", () =>
    withClock(MAX_DATE_TIMESTAMP_MS, async () => {
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
    }));

  it("ignores invalid caller-supplied drain deadlines", () =>
    withClock("2026-05-30T00:00:00Z", async () => {
      const result = await waitForAgentRunsToDrain({
        deadlineAtMs: Number.POSITIVE_INFINITY,
        getPendingRunIds: async () => ["run-1"],
      });

      expect(result.timedOut).toBe(true);
      expect(result.pendingRunIds).toStrictEqual(["run-1"]);
      expect(result.deadlineAtMs).toBe(Date.now());
      expect(callGatewayMock).not.toHaveBeenCalled();
    }));
});
