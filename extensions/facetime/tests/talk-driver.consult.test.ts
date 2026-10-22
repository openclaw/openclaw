import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mocks,
  resetTalkDriverMocks,
  startReadyFaceTimeTalkDriver as startReady,
} from "./talk-driver.test-support.js";

const { bridge, pump, consult: agentConsult, onFailure } = mocks;

function deferConsult() {
  const { promise, resolve } = Promise.withResolvers<{ text: string }>();
  agentConsult.mockImplementationOnce(() => promise);
  return resolve;
}

function consult(
  itemId: string,
  callId: string,
  question: string,
  name = "openclaw_agent_consult",
) {
  return mocks.sessionParams?.onToolCall({
    itemId,
    callId,
    name,
    args: { question },
  });
}

async function consultStarted(count = 1) {
  await vi.waitFor(() => expect(agentConsult).toHaveBeenCalledTimes(count));
  return agentConsult.mock.calls[count - 1]?.[0] as { abortSignal: AbortSignal };
}

describe("FaceTime talk driver consult delivery", () => {
  beforeEach(resetTalkDriverMocks);

  it("cancels a superseded consult without aborting its successor on late completion", async () => {
    const finishFirst = deferConsult();
    await startReady();
    void consult("item-consult-a", "consult-a", "consult-a");
    const first = await consultStarted();
    void consult("item-consult-b", "consult-b", "consult-b");
    const second = await consultStarted(2);

    expect(first.abortSignal.aborted).toBe(true);
    expect(second.abortSignal.aborted).toBe(false);
    finishFirst({ text: "Superseded answer." });
    await Promise.resolve();
    expect(second.abortSignal.aborted).toBe(false);
    expect(bridge.submitToolResult).not.toHaveBeenCalledWith("consult-a", {
      text: "Superseded answer.",
    });
  });

  it("retires old consult and playback ownership on provider continuity reset", async () => {
    const finishConsult = deferConsult();
    await startReady();
    void consult("item-reset", "consult-reset", "old");
    const consultParams = await consultStarted();

    mocks.sessionParams?.onEvent({ direction: "server", type: "session.continuity.reset" });
    expect(consultParams.abortSignal.aborted).toBe(true);
    expect(pump.clearOutputAudio).toHaveBeenCalled();
    finishConsult({ text: "stale" });
    await Promise.resolve();
    expect(bridge.submitToolResult).not.toHaveBeenCalledWith(
      "consult-reset",
      expect.objectContaining({ text: "stale" }),
    );
  });

  it("keeps a pending consult alive while the caller continues speaking", async () => {
    const finishConsult = deferConsult();
    await startReady();

    void consult("item-1", "call-1", "Who am I?");
    const consultParams = await consultStarted();
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "input_audio_buffer.speech_started",
    });
    mocks.sessionParams?.onTranscript?.("user", "Actually, do something else.", true);

    expect(consultParams.abortSignal.aborted).toBe(false);
    expect(bridge.submitToolResult).not.toHaveBeenCalled();
    finishConsult({ text: "You are Omar." });
    await vi.waitFor(() =>
      expect(bridge.submitToolResult).toHaveBeenCalledWith("call-1", {
        text: "You are Omar.",
      }),
    );
  });

  it("uses an unsuppressed terminal cancellation when the provider requires it", async () => {
    bridge.bridge.supportsToolResultSuppression = false;
    await startReady();

    void consult("item-1", "call-1", "Who am I?");
    void consult("item-2", "call-2", "Actually, do something else.");

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
  });

  it("closes safely when a terminal consult cancellation cannot be submitted", async () => {
    bridge.submitToolResult.mockRejectedValueOnce(new Error("submission failed"));
    await startReady();

    void consult("item-1", "call-1", "Who am I?");
    void consult("item-2", "call-2", "Actually, do something else.");

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(new Error("submission failed")));
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it.each(["backend error", "working", "unknown tool", "recovery error"])(
    "reports failed %s delivery without retrying the provider write",
    async (kind) => {
      bridge.bridge.supportsToolResultContinuation = kind === "working";
      agentConsult.mockReset();
      if (kind === "backend error") {
        agentConsult.mockRejectedValueOnce(new Error("backend failed"));
      } else {
        agentConsult.mockResolvedValueOnce({ text: "Answer." });
      }
      bridge.submitToolResult.mockRejectedValueOnce(new Error("delivery failed"));
      if (kind === "recovery error") {
        onFailure.mockRejectedValueOnce(new Error("recovery failed"));
      }
      const logger = { ...console, warn: vi.fn() };
      const driver = await startReady({ logger });
      void consult(
        "item-delivery",
        "call-delivery",
        "Check my calendar.",
        kind === "unknown tool" ? "unknown" : undefined,
      );

      await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
      expect(onFailure).toHaveBeenCalledWith(new Error("delivery failed"));
      expect(bridge.submitToolResult).toHaveBeenCalledOnce();
      expect(bridge.close).toHaveBeenCalledOnce();
      expect(driver.recentTalkEvents).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tool.result" })]),
      );
      if (kind === "working") {
        expect(agentConsult).not.toHaveBeenCalled();
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
      agentConsult.mockResolvedValueOnce({ text: "Answer." });
      bridge.submitToolResult.mockImplementationOnce(() => {
        deliveryStarted.resolve();
        return delivery.promise;
      });
      const driver = await startReady();
      void consult("item-delivery", "call-delivery", "Check my calendar.");
      await withTimeout(deliveryStarted.promise, 1_000, {
        message: "Consult delivery did not start",
      });
      expect(bridge.submitToolResult).toHaveBeenCalledOnce();
      if (transition === "close") {
        const consultParams = agentConsult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };
        expect(consultParams.abortSignal.aborted).toBe(false);
        await driver.close("carrier-ended");
        expect(consultParams.abortSignal.aborted).toBe(true);
      } else {
        await consult("item-replacement", "call-replacement", "Check my reminders instead.");
        expect(agentConsult).toHaveBeenCalledTimes(2);
      }
      if (settlement === "accepted") {
        delivery.resolve();
      } else {
        delivery.reject(new Error("late failure"));
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(bridge.submitToolResult).toHaveBeenCalledOnce();
      if (transition === "replacement" && settlement === "rejected") {
        expect(onFailure).toHaveBeenCalledOnce();
        expect(onFailure).toHaveBeenCalledWith(new Error("late failure"));
        expect(bridge.close).toHaveBeenCalledOnce();
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

  it("routes one normalized FaceTime session to the sole configured agent", async () => {
    agentConsult.mockResolvedValueOnce({ text: "I know my SOUL.md." });
    await startReady({
      callUUID: "17BC43FD-5800-4B54-86DB-698C49253C42",
      fullConfig: { agents: { entries: { lobster: {} } } },
    });

    void consult("item-1", "call-1", "Can you read SOUL.md?");

    await vi.waitFor(() =>
      expect(agentConsult).toHaveBeenCalledWith(
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
    expect(agentConsult.mock.calls[0]?.[0].extraSystemPrompt).toContain("answer immediately");
  });
});
