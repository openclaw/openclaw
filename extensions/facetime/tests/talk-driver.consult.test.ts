import { setImmediate } from "node:timers/promises";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import {
  mocks,
  resetTalkDriverMocks,
  startReadyFaceTimeTalkDriver as startReady,
} from "./talk-driver.test-support.js";

const { bridge, pump, onFailure } = mocks;

function consult(callId: string, name = "openclaw_agent_consult") {
  return mocks.sessionParams?.onToolCall({
    itemId: `item-${callId}`,
    callId,
    name,
    args: { question: callId },
  });
}

beforeEach(resetTalkDriverMocks);

it("never lets late cancellation of a superseded consult abort its successor", async () => {
  await startReady();
  void consult("consult-a");
  await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledTimes(1));
  void consult("consult-b");
  await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledTimes(2));
  const first = mocks.consult.mock.calls[0]?.[0] as {
    abortSignal: AbortSignal;
    onRunStarted(params: { runId: string; sessionId: string; timeoutMs: number }): {
      abortSignal: AbortSignal;
    };
  };
  const second = mocks.consult.mock.calls[1]?.[0] as typeof first;
  const run = (params: typeof first, runId: string) =>
    params.onRunStarted({ runId, sessionId: "shared-session", timeoutMs: 1_000 });
  const secondRun = run(second, "run-b");
  const lateFirstRun = run(first, "run-a");
  expect(
    [first, lateFirstRun, second, secondRun].map(({ abortSignal }) => abortSignal.aborted),
  ).toEqual([true, true, false, false]);
});

it.each(["session.continuity.reset", "input_audio_buffer.speech_started"])(
  "preserves consult ownership across %s",
  async (type) => {
    const result = Promise.withResolvers<{ text: string }>();
    mocks.consult.mockReturnValueOnce(result.promise);
    await startReady();
    void consult("call-1");
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledOnce());
    const params = mocks.consult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };
    mocks.sessionParams?.onEvent({ direction: "server", type });
    const reset = type === "session.continuity.reset";
    if (!reset) {
      mocks.sessionParams?.onTranscript?.("user", "Actually, do something else.", true);
    }
    expect(params.abortSignal.aborted).toBe(reset);
    if (reset) {
      expect(pump.clearOutputAudio).toHaveBeenCalled();
      result.resolve({ text: "stale" });
      await Promise.resolve();
      expect(bridge.submitToolResult).not.toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({ text: "stale" }),
      );
    } else {
      expect(bridge.submitToolResult).not.toHaveBeenCalled();
      result.resolve({ text: "You are Omar." });
      await vi.waitFor(() =>
        expect(bridge.submitToolResult).toHaveBeenCalledWith("call-1", { text: "You are Omar." }),
      );
    }
  },
);

it.each([false, true])(
  "settles replaced consult when cancellation delivery fails=%s",
  async (fails) => {
    bridge.bridge.supportsToolResultSuppression = fails;
    if (fails) {
      bridge.submitToolResult.mockRejectedValueOnce(new Error("submission failed"));
    }
    await startReady();
    void consult("call-1");
    void consult("call-2");
    if (fails) {
      await vi.waitFor(() =>
        expect(onFailure).toHaveBeenCalledWith(new Error("submission failed")),
      );
      expect(bridge.close).toHaveBeenCalledOnce();
    } else {
      await vi.waitFor(() =>
        expect(bridge.submitToolResult).toHaveBeenCalledWith(
          "call-1",
          {
            status: "cancelled",
            message: "A new agent consult replaced this request before it completed.",
          },
          undefined,
        ),
      );
    }
  },
);

it.each(["backend error", "working", "unknown tool", "recovery error"])(
  "reports failed %s delivery without retrying the provider write",
  async (kind) => {
    bridge.bridge.supportsToolResultContinuation = kind === "working";
    mocks.consult.mockReset();
    if (kind === "backend error") {
      mocks.consult.mockRejectedValueOnce(new Error("backend failed"));
    } else {
      mocks.consult.mockResolvedValueOnce({ text: "Answer." });
    }
    bridge.submitToolResult.mockRejectedValueOnce(new Error("delivery failed"));
    if (kind === "recovery error") {
      onFailure.mockRejectedValueOnce(new Error("recovery failed"));
    }
    const logger = { ...console, warn: vi.fn() };
    const driver = await startReady({ logger });

    void consult("call-delivery", kind === "unknown tool" ? "unknown" : undefined);

    await vi.waitFor(() =>
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(new Error("delivery failed")),
    );
    expect(bridge.submitToolResult).toHaveBeenCalledOnce();
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(driver.recentTalkEvents).not.toContainEqual(
      expect.objectContaining({ type: "tool.result" }),
    );
    if (kind === "working") {
      expect(mocks.consult).not.toHaveBeenCalled();
    }
    if (kind === "recovery error") {
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          "[facetime] tool delivery recovery failed: recovery failed",
        ),
      );
    }
  },
);

it.each([
  { settlement: "accepted", transition: "close" },
  { settlement: "rejected", transition: "close" },
  { settlement: "rejected", transition: "replacement" },
])(
  "settles $settlement delivery correctly after $transition",
  async ({ settlement, transition }) => {
    const deliveryStarted = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<void>();
    mocks.consult.mockResolvedValueOnce({ text: "Answer." });
    bridge.submitToolResult.mockImplementationOnce(() => {
      deliveryStarted.resolve();
      return delivery.promise;
    });
    const driver = await startReady();
    void consult("call-delivery");
    await withTimeout(deliveryStarted.promise, 1_000, {
      message: "Consult delivery did not start",
    });
    expect(bridge.submitToolResult).toHaveBeenCalledOnce();
    if (transition === "close") {
      const consultParams = mocks.consult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };
      expect(consultParams.abortSignal.aborted).toBe(false);
      await driver.close("carrier-ended");
      expect(consultParams.abortSignal.aborted).toBe(true);
    } else {
      await consult("call-replacement");
      expect(mocks.consult).toHaveBeenCalledTimes(2);
    }
    if (settlement === "accepted") {
      delivery.resolve();
    } else {
      delivery.reject(new Error("late failure"));
    }
    await setImmediate();
    expect(bridge.submitToolResult).toHaveBeenCalledOnce();
    if (transition === "replacement" && settlement === "rejected") {
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(new Error("late failure"));
      expect(bridge.close).toHaveBeenCalledOnce();
    } else {
      expect(onFailure).not.toHaveBeenCalled();
    }
    expect(driver.recentTalkEvents).not.toContainEqual(
      expect.objectContaining({ type: "tool.result", callId: "call-delivery" }),
    );
  },
);

it("routes one normalized FaceTime session to the sole configured agent", async () => {
  mocks.consult.mockResolvedValueOnce({ text: "I know my SOUL.md." });
  await startReady({
    callUUID: "17BC43FD-5800-4B54-86DB-698C49253C42",
    fullConfig: { agents: { entries: { lobster: {} } } },
  });

  void consult("call-1");

  await vi.waitFor(() =>
    expect(mocks.consult.mock.calls[0]?.[0]).toMatchObject({
      agentId: "lobster",
      sessionKey: "agent:lobster:facetime:17bc43fd-5800-4b54-86db-698c49253c42",
      spawnedBy: "agent:lobster:main",
      contextMode: "fork",
      senderId: "caller@example.com",
      senderIsOwner: true,
      messageProvider: "voice",
      lane: "facetime:17bc43fd-5800-4b54-86db-698c49253c42",
      runIdPrefix: "facetime:17bc43fd-5800-4b54-86db-698c49253c42",
      thinkLevel: "off",
      extraSystemPrompt: expect.stringContaining(
        "configured owner/user described by this agent's workspace context",
      ),
    }),
  );
  expect(mocks.consult.mock.calls[0]?.[0].extraSystemPrompt).toContain("answer immediately");
});
