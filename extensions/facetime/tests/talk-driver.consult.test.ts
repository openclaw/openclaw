import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mocks,
  resetTalkDriverMocks,
  startParams,
  startReadyFaceTimeTalkDriver,
} from "./talk-driver.test-support.js";

function deferConsult() {
  const { promise, resolve } = Promise.withResolvers<{ text: string }>();
  mocks.consult.mockImplementationOnce(() => promise);
  return resolve;
}

function consult(itemId: string, callId: string, question: string) {
  return mocks.sessionParams?.onToolCall({
    itemId,
    callId,
    name: "openclaw_agent_consult",
    args: { question },
  });
}

describe("FaceTime talk driver consult delivery", () => {
  beforeEach(resetTalkDriverMocks);

  it("never lets late cancellation of a superseded consult abort its successor", async () => {
    mocks.consult.mockImplementation(() => new Promise<{ text: string }>(() => {}));
    await startReadyFaceTimeTalkDriver();
    const runTool = (callId: string) =>
      void mocks.sessionParams?.onToolCall({
        itemId: `item-${callId}`,
        callId,
        name: "openclaw_agent_consult",
        args: { question: callId },
      });

    runTool("consult-a");
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledTimes(1));
    runTool("consult-b");
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledTimes(2));
    const first = mocks.consult.mock.calls[0]?.[0] as {
      abortSignal: AbortSignal;
      onRunStarted(params: { runId: string; sessionId: string; timeoutMs: number }): {
        abortSignal: AbortSignal;
      };
    };
    const second = mocks.consult.mock.calls[1]?.[0] as typeof first;
    const secondRun = second.onRunStarted({
      runId: "run-b",
      sessionId: "shared-session",
      timeoutMs: 1_000,
    });
    const lateFirstRun = first.onRunStarted({
      runId: "run-a",
      sessionId: "shared-session",
      timeoutMs: 1_000,
    });

    expect(first.abortSignal.aborted).toBe(true);
    expect(lateFirstRun.abortSignal.aborted).toBe(true);
    expect(second.abortSignal.aborted).toBe(false);
    expect(secondRun.abortSignal.aborted).toBe(false);
  });

  it("retires old consult and playback ownership on provider continuity reset", async () => {
    const finishConsult = deferConsult();
    await startReadyFaceTimeTalkDriver();
    void consult("item-reset", "consult-reset", "old");
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledOnce());
    const consultParams = mocks.consult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };

    mocks.sessionParams?.onEvent({ direction: "server", type: "session.continuity.reset" });
    expect(consultParams.abortSignal.aborted).toBe(true);
    expect(mocks.pump.clearOutputAudio).toHaveBeenCalled();
    finishConsult({ text: "stale" });
    await Promise.resolve();
    expect(mocks.bridge.submitToolResult).not.toHaveBeenCalledWith(
      "consult-reset",
      expect.objectContaining({ text: "stale" }),
    );
  });

  it("keeps a pending consult alive while the caller continues speaking", async () => {
    const finishConsult = deferConsult();
    await startReadyFaceTimeTalkDriver();

    void consult("item-1", "call-1", "Who am I?");
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledOnce());
    const consultParams = mocks.consult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "input_audio_buffer.speech_started",
    });
    mocks.sessionParams?.onTranscript?.("user", "Actually, do something else.", true);

    expect(consultParams.abortSignal.aborted).toBe(false);
    expect(mocks.bridge.submitToolResult).not.toHaveBeenCalled();
    finishConsult({ text: "You are Omar." });
    await vi.waitFor(() =>
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith("call-1", {
        text: "You are Omar.",
      }),
    );
  });

  it("uses an unsuppressed terminal cancellation when the provider requires it", async () => {
    (
      mocks.bridge.bridge as { supportsToolResultSuppression?: boolean }
    ).supportsToolResultSuppression = false;
    mocks.consult.mockImplementationOnce(() => new Promise<{ text: string }>(() => {}));
    await startReadyFaceTimeTalkDriver();

    void consult("item-1", "call-1", "Who am I?");
    void consult("item-2", "call-2", "Actually, do something else.");

    await vi.waitFor(() =>
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith(
        "call-1",
        {
          status: "cancelled",
          message: "A new agent consult replaced this request before it completed.",
        },
        undefined,
      ),
    );
  });

  it("closes safely when a terminal consult cancellation cannot be submitted", async () => {
    mocks.bridge.submitToolResult.mockRejectedValueOnce(new Error("submission failed"));
    mocks.consult.mockImplementationOnce(() => new Promise<{ text: string }>(() => {}));
    const onFailure = vi.fn(async () => true);
    await startReadyFaceTimeTalkDriver(startParams({ onFailure }));

    void consult("item-1", "call-1", "Who am I?");
    void consult("item-2", "call-2", "Actually, do something else.");

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(new Error("submission failed")));
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it.each(["backend error", "working", "unknown tool", "recovery error"])(
    "reports failed %s delivery without retrying the provider write",
    async (kind) => {
      mocks.bridge.bridge.supportsToolResultContinuation = kind === "working";
      mocks.consult.mockReset();
      if (kind === "backend error") {
        mocks.consult.mockRejectedValueOnce(new Error("backend failed"));
      } else {
        mocks.consult.mockResolvedValueOnce({ text: "Answer." });
      }
      mocks.bridge.submitToolResult.mockRejectedValueOnce(new Error("delivery failed"));
      const onFailure = vi.fn(async () => true);
      if (kind === "recovery error") {
        onFailure.mockRejectedValueOnce(new Error("recovery failed"));
      }
      const logger = { ...console, warn: vi.fn() };
      const driver = await startReadyFaceTimeTalkDriver(startParams({ onFailure, logger }));

      void mocks.sessionParams?.onToolCall({
        itemId: "item-delivery",
        callId: "call-delivery",
        name: kind === "unknown tool" ? "unknown" : "openclaw_agent_consult",
        args: { question: "Check my calendar." },
      });

      await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
      expect(onFailure).toHaveBeenCalledWith(new Error("delivery failed"));
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledOnce();
      expect(mocks.bridge.close).toHaveBeenCalledOnce();
      expect(driver.recentTalkEvents).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tool.result" })]),
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
      let finishDelivery = () => {};
      mocks.consult
        .mockReset()
        .mockImplementation(() => new Promise(() => {}))
        .mockResolvedValueOnce({ text: "Answer." });
      mocks.bridge.submitToolResult.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            finishDelivery = () =>
              settlement === "accepted" ? resolve() : reject(new Error("late failure"));
            deliveryStarted.resolve();
          }),
      );
      const onFailure = vi.fn(async () => true);
      const driver = await startReadyFaceTimeTalkDriver(startParams({ onFailure }));
      void consult("item-delivery", "call-delivery", "Check my calendar.");
      await withTimeout(deliveryStarted.promise, 1_000, {
        message: "Consult delivery did not start",
      });
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledOnce();
      if (transition === "close") {
        await driver.close("carrier-ended");
      } else {
        await consult("item-replacement", "call-replacement", "Check my reminders instead.");
        expect(mocks.consult).toHaveBeenCalledTimes(2);
      }
      finishDelivery();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledOnce();
      if (transition === "replacement" && settlement === "rejected") {
        expect(onFailure).toHaveBeenCalledOnce();
        expect(onFailure).toHaveBeenCalledWith(new Error("late failure"));
        expect(mocks.bridge.close).toHaveBeenCalledOnce();
      } else {
        expect(onFailure).not.toHaveBeenCalled();
      }
      expect(driver.recentTalkEvents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool.result", callId: "call-delivery" }),
        ]),
      );
    },
  );

  it("routes one normalized FaceTime session to the configured default agent", async () => {
    mocks.consult.mockResolvedValueOnce({ text: "I know my SOUL.md." });
    await startReadyFaceTimeTalkDriver(
      startParams({
        callUUID: "17BC43FD-5800-4B54-86DB-698C49253C42",
        fullConfig: {
          agents: { list: [{ id: "lobster", default: true }] },
        },
      }),
    );

    void consult("item-1", "call-1", "Can you read SOUL.md?");

    await vi.waitFor(() =>
      expect(mocks.consult).toHaveBeenCalledWith(
        expect.objectContaining({
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
      ),
    );
    expect(mocks.consult.mock.calls[0]?.[0].extraSystemPrompt).toContain("answer immediately");
  });
});
