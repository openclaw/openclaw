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

function pendingRuns(...batches: string[][]) {
  return async () => batches.shift() ?? [];
}

function mockRunReply(response: unknown) {
  callGatewayMock.mockImplementation(async (request) => {
    if (request.method !== "agent.wait") {
      throw new Error("session history is not delivery evidence");
    }
    return response;
  });
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
        assistant("real worker reply"),
        assistant("already delivered through message tool", {
          openclawMessageToolMirror: {
            toolName: "message",
            toolCallId: "call-message-send",
          },
        }),
        assistant("gateway notice", {
          provider: "openclaw",
          model: "gateway-injected",
        }),
      ],
      "real worker reply",
    );
  });

  it("skips a trailing projected cron run prompt for latest-reply reads", async () => {
    const provenance = {
      kind: "internal_system",
      sourceTool: "cron",
      sourceSessionKey: "agent:main:cron:job-1:run:run-1",
    };
    await expectLatestReply(
      [assistant("older worker reply"), assistant("forwarded input text", { provenance })],
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

  it.each([false, true])("reads capped history with rejected lookup=%s", async (rejected) => {
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "chat.history") {
        return { messages: [cappedMessage] };
      }
      if (rejected) {
        throw new Error("session changed while reading history; reload the conversation");
      }
      return { ok: true, message: textAssistant("Report head and the full remainder.") };
    });

    await expect(
      readLatestAssistantReply({
        sessionKey: "agent:main:child",
        agentId: rejected ? undefined : "main",
      }),
    ).resolves.toBe(rejected ? undefined : "Report head and the full remainder.");
    expect(callGatewayMock).toHaveBeenLastCalledWith({
      method: "chat.message.get",
      params: {
        sessionKey: "agent:main:child",
        ...(rejected ? {} : { agentId: "main" }),
        messageId: "msg-1",
      },
    });
  });
});

describe("waitForAgentRun", () => {
  it("preserves pending error diagnostics on wait timeouts", async () => {
    const pending = {
      status: "timeout",
      error: "429 RESOURCE_EXHAUSTED",
      pendingError: true,
    };
    callGatewayMock.mockResolvedValue(pending);
    await expect(waitForAgentRun({ runId: "run-pending-error", timeoutMs: 500 })).resolves.toEqual(
      pending,
    );
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
    const model = { provider: "openai", model: "gpt-5.6-luna" };
    callGatewayMock.mockResolvedValue({
      status: "ok",
      terminalReceipt: {
        runId: entry.receiptRunId ?? "run-source-reply",
        sessionId: "session-source",
        turnId: "turn-source",
        requested: model,
        effective: { ...model, responseModel: model.model },
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

  it.each([
    {
      fields: {
        livenessState: "blocked",
        error: "Context overflow: prompt too large for the model.",
      },
      error: "Context overflow: prompt too large for the model.",
    },
    { fields: { stopReason: "aborted" }, error: "agent run aborted" },
  ])("normalizes ok waits with $fields to errors", async ({ fields, error }) => {
    const timing = { startedAt: 100, endedAt: 200 };
    callGatewayMock.mockResolvedValue({ status: "ok", ...timing, ...fields });
    await expect(waitForAgentRun({ runId: "run-stopped", timeoutMs: 500 })).resolves.toEqual({
      status: "error",
      ...timing,
      ...fields,
      error,
    });
  });
});

describe("waitForAgentRunReply", () => {
  it("returns the run's reply and metadata without consulting unrelated session history", async () => {
    mockRunReply({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      stopReason: "completed",
      yielded: true,
      providerStarted: true,
      terminalReply: { disposition: "visible", text: "authoritative reply" },
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
    mockRunReply({ status: "ok", terminalReply });

    await expect(waitReply("run-no-reply")).resolves.toEqual({ status: "ok", terminalReply });
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

      expect(result).toMatchObject({ timedOut: false, pendingRunIds: [] });
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

    const result = await waitForAgentRunsToDrain({
      timeoutMs: 1_000,
      initialPendingRunIds: ["run-1"],
      getPendingRunIds: pendingRuns(["run-2"]),
    });

    expect(result.timedOut).toBe(false);
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expectAgentWaitRequest(0, "run-1", 1_000);
    expectAgentWaitRequest(1, "run-2", 1_000);
  });

  it("defaults non-finite drain timeouts before computing the deadline", () =>
    withClock("2026-05-30T00:00:00Z", async () => {
      callGatewayMock.mockResolvedValue({ status: "ok" });

      const result = await waitForAgentRunsToDrain({
        timeoutMs: Number.NaN,
        getPendingRunIds: pendingRuns(["run-1"]),
      });

      expect(result.timedOut).toBe(false);
      expect(Number.isFinite(result.deadlineAtMs)).toBe(true);
      expectAgentWaitRequest(0, "run-1", 1);
    }));

  it.each([
    { name: "Date overflow", clock: MAX_DATE_TIMESTAMP_MS, options: { timeoutMs: 1 } },
    {
      name: "infinite deadline",
      clock: Date.parse("2026-05-30T00:00:00Z"),
      options: { deadlineAtMs: Number.POSITIVE_INFINITY },
    },
  ])("expires $name immediately without waiting", ({ clock, options }) =>
    withClock(clock, async () => {
      const result = await waitForAgentRunsToDrain({
        ...options,
        getPendingRunIds: async () => ["run-1"],
      });

      expect(result).toEqual({
        timedOut: true,
        pendingRunIds: ["run-1"],
        deadlineAtMs: clock,
      });
      expect(callGatewayMock).not.toHaveBeenCalled();
    }),
  );
});
