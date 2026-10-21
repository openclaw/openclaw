import assert from "node:assert/strict";
import {
  addTimerTimeoutGraceMs,
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProtocolRequestError } from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import * as gatewayCallRuntime from "../gateway/call.js";
import { GatewayDispatchUnavailableError } from "../infra/restart-recovery-errors.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  readLatestAssistantReply,
  waitForAgentRun,
  waitForAgentRunsToDrain,
  waitForAgentRunReply,
} from "./run-wait.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

const callGatewayMock = vi.spyOn(gatewayCallRuntime, "callGateway");
afterAll(() => callGatewayMock.mockRestore());
beforeEach(() => callGatewayMock.mockReset());
afterEach(() => vi.useRealTimers());

const sessionKey = "agent:main:child";
const readReply = (agentId?: string) => readLatestAssistantReply({ sessionKey, agentId });
const wait = (runId = "run-observed") => waitForAgentRun({ runId, timeoutMs: 500 });
const observe = (untilTerminal?: true) =>
  waitForAgentRunReply({ runId: "run-ended", timeoutMs: 1_000, untilTerminal });
const textRow = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });
const assistant = (text: string, fields = {}) => ({ ...textAssistant(text), ...fields });
const compaction = textRow("system", "Compaction");
const signedText = (text: string, id: string, phase: string) => ({
  type: "text",
  text,
  textSignature: JSON.stringify({ v: 1, id, phase }),
});
const capped = {
  ...textAssistant("Report head\n...(truncated)..."),
  __openclaw: { id: "msg-1", truncated: true, reason: "display-cap" },
};
function mockCappedLookup(lookup: () => { ok: true; message: ReturnType<typeof textAssistant> }) {
  callGatewayMock.mockImplementation(async (request) =>
    request.method === "chat.history" ? { messages: [capped] } : lookup(),
  );
}
function waitOnly(response: Record<string, unknown>) {
  callGatewayMock.mockImplementation(async ({ method }) => {
    if (method !== "agent.wait") {
      throw new Error("history must not override terminal reply evidence");
    }
    return response;
  });
}
function expectAgentWaitRequest(index: number, runId: string, maxParamTimeoutMs: number) {
  const request = callGatewayMock.mock.calls.at(index)?.[0];
  assert(request, "expected gateway wait request");
  expect(request).toMatchObject({ method: "agent.wait", params: { runId } });
  assert(request.params && typeof request.params === "object" && "timeoutMs" in request.params);
  const paramTimeoutMs = request.params.timeoutMs;
  const requestTimeoutMs = request.timeoutMs;
  assert(typeof paramTimeoutMs === "number" && typeof requestTimeoutMs === "number");
  expect(requestTimeoutMs).toBe(addTimerTimeoutGraceMs(paramTimeoutMs, 2_000));
  expect(requestTimeoutMs).toBeLessThanOrEqual(
    addTimerTimeoutGraceMs(maxParamTimeoutMs, 2_000) ?? MAX_TIMER_TIMEOUT_MS,
  );
  expect(paramTimeoutMs).toBeGreaterThanOrEqual(1);
  expect(paramTimeoutMs).toBeLessThanOrEqual(maxParamTimeoutMs);
}

describe("readLatestAssistantReply", () => {
  it.each<[string, string, unknown[]]>([
    [
      "trailing compaction markers",
      "All checks passed and changes were pushed.",
      [
        textAssistant("All checks passed and changes were pushed."),
        textRow("toolResult", "tool output"),
        compaction,
      ],
    ],
    [
      "an empty latest assistant",
      "older output",
      [textAssistant("older output"), { role: "assistant", content: [] }, compaction],
    ],
    [
      "transcript-only assistant mirrors",
      "real worker reply",
      [
        assistant("real worker reply", { timestamp: 10 }),
        assistant("already delivered through message tool", {
          timestamp: 11,
          openclawMessageToolMirror: { toolName: "message", toolCallId: "call-message-send" },
        }),
        assistant("gateway notice", {
          provider: "openclaw",
          model: "gateway-injected",
          timestamp: 12,
        }),
      ],
    ],
    [
      "a projected cron prompt",
      "older worker reply",
      [
        assistant("older worker reply", { timestamp: 10 }),
        assistant("forwarded input text", {
          timestamp: 11,
          provenance: {
            kind: "internal_system",
            sourceTool: "cron",
            jobId: "job-1",
            runId: "run-1",
            sourceSessionKey: "agent:main:cron:job-1:run:run-1",
          },
        }),
      ],
    ],
    [
      "spaces across final-answer blocks",
      "Hi there",
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
    ],
  ])("reads the latest reply with %s", async (_name, reply, messages) => {
    callGatewayMock.mockResolvedValue({ messages });
    await expect(readReply()).resolves.toBe(reply);
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey, limit: 50 },
    });
  });
  it("reads the full message when history returns a display-capped preview", async () => {
    mockCappedLookup(() => ({
      ok: true,
      message: textAssistant("Report head and the full remainder."),
    }));
    await expect(readReply("main")).resolves.toBe("Report head and the full remainder.");
    expect(callGatewayMock).toHaveBeenLastCalledWith({
      method: "chat.message.get",
      params: { sessionKey, agentId: "main", messageId: "msg-1" },
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
    ["confirmed final source reply", true, undefined, true],
    ["non-boolean marker", "true", undefined, undefined],
    ["another run", true, "run-other", undefined],
  ] as const)(
    "accepts source delivery evidence only for the waited run: %s",
    async (_name, sourceReplyDelivered, receiptRunId, expected) => {
      const route = { provider: "openai", model: "gpt-5.6-luna" };
      callGatewayMock.mockResolvedValue({
        status: "ok",
        terminalReceipt: {
          runId: receiptRunId ?? "run-source-reply",
          sessionId: "session-source",
          turnId: "turn-source",
          requested: route,
          effective: { ...route, responseModel: route.model },
          successfulToolNames: ["message"],
          rerouted: false,
          terminalDisposition: "visible",
          sourceReplyDelivered,
        },
      });
      expect((await wait("run-source-reply")).sourceReplyDelivered).toBe(expected);
    },
  );
  it.each(["gateway-restarting", "gateway-suspending", undefined])(
    "keeps a %s refusal retryable without reclassifying terminal run text",
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
      expect(terminal).toMatchObject({ status: "error", error: message, endedAt: 200 });
      expect(terminal.retryableTransportError).toBeUndefined();
    },
  );
  it.each([
    [
      false,
      new GatewayProtocolRequestError({
        code: "UNAVAILABLE",
        message: "agent.wait unavailable during gateway suspension",
        retryable: true,
      }),
      true,
    ],
    [true, new GatewayDispatchUnavailableError("agent.wait", false), true],
    [false, new GatewayDispatchUnavailableError("agent.wait", false), false],
  ] as const)("classifies refusal (draining=%s, cause=%s)", async (draining, cause, retryable) => {
    resetGatewayWorkAdmission();
    if (draining) {
      markGatewayRestartDraining("stop (SIGTERM)");
    }
    try {
      callGatewayMock.mockRejectedValueOnce(cause);
      expect(await wait()).toMatchObject({
        status: "error",
        error: cause.message,
        retryableTransportError: retryable ? true : undefined,
      });
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
    waitOnly(response);
    await expect(observe()).resolves.toEqual({ ...response, replyText: "authoritative reply" });
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(["agent.wait"]);
  });
  it.each(["silent", "empty"])(
    "does not resurrect history for a %s terminal reply",
    async (disposition) => {
      const terminalReply = { disposition };
      waitOnly({ status: "ok", terminalReply });
      const result = await observe();
      expect(result).toEqual({ status: "ok", terminalReply });
      expect(result.replyText).toBeUndefined();
      expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(["agent.wait"]);
    },
  );
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
  it("lets completion callbacks drain runs after immediate ok responses", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = ["run-1"];
    const completion = setTimeout(() => {
      activeRunIds = [];
    }, 0);
    try {
      await waitForAgentRunsToDrain({ timeoutMs: 200, getPendingRunIds: async () => activeRunIds });
      expect(activeRunIds).toEqual([]);
      expect(callGatewayMock).toHaveBeenCalled();
      expect(callGatewayMock.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      clearTimeout(completion);
    }
  });
  it("bounds retries of unchanged runs by the drain deadline", async () => {
    callGatewayMock.mockResolvedValue({ status: "pending" });
    const deadlineAtMs = Date.now() + 150;
    await waitForAgentRunsToDrain({ deadlineAtMs, getPendingRunIds: async () => ["run-1"] });
    expect(Date.now()).toBeGreaterThanOrEqual(deadlineAtMs);
    expect(callGatewayMock.mock.calls.length).toBeLessThanOrEqual(4);
    expectAgentWaitRequest(0, "run-1", 150);
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
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expectAgentWaitRequest(0, "run-1", 1_000);
    expectAgentWaitRequest(1, "run-2", 1_000);
  });
  it("defaults non-finite drain timeouts before computing the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T00:00:00Z"));
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = ["run-1"];
    await waitForAgentRunsToDrain({
      timeoutMs: Number.NaN,
      getPendingRunIds: async () => {
        const current = activeRunIds;
        activeRunIds = [];
        return current;
      },
    });
    expect(activeRunIds).toEqual([]);
    expectAgentWaitRequest(0, "run-1", 1);
  });
  it.each([
    [MAX_DATE_TIMESTAMP_MS, { timeoutMs: 1 }],
    [Date.parse("2026-05-30T00:00:00Z"), { deadlineAtMs: Number.POSITIVE_INFINITY }],
  ] as const)("does not wait past an invalid drain deadline at %s", async (now, options) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    await waitForAgentRunsToDrain({ ...options, getPendingRunIds: async () => ["run-1"] });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});
