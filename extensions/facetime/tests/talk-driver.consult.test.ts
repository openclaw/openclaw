import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mocks,
  resetTalkDriverMocks,
  startParams,
  startReadyFaceTimeTalkDriver,
} from "./talk-driver.test-support.js";

describe("FaceTime talk driver consult delivery", () => {
  beforeEach(resetTalkDriverMocks);

  it("aborts a pending agent consult when the FaceTime call closes", async () => {
    mocks.bridge.connect.mockResolvedValue();
    let finishConsult = (_result: { text: string }) => {};
    mocks.consult.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finishConsult = resolve;
        }),
    );
    const driver = await startReadyFaceTimeTalkDriver();

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Change my calendar." },
    });
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledOnce());
    const consultParams = mocks.consult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };

    await driver.close("carrier-ended");

    expect(consultParams.abortSignal.aborted).toBe(true);
    finishConsult({ text: "Too late." });
    await Promise.resolve();
    expect(mocks.bridge.submitToolResult).not.toHaveBeenCalled();
  });

  it("rejects a late exact-run registration after the consult was closed", async () => {
    mocks.bridge.connect.mockResolvedValue();
    mocks.consult.mockImplementationOnce(() => new Promise<{ text: string }>(() => {}));
    const params = startParams();
    mocks.getSessionEntry.mockReturnValue(undefined);
    const driver = await startReadyFaceTimeTalkDriver(params);

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Change my calendar." },
    });
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledOnce());
    const consultParams = mocks.consult.mock.calls[0]?.[0] as {
      abortSignal: AbortSignal;
      onRunStarted(params: { runId: string; sessionId: string; timeoutMs: number }): {
        abortSignal: AbortSignal;
      };
    };
    await driver.close("carrier-ended");
    const registration = consultParams.onRunStarted({
      runId: "old-run",
      sessionId: "shared-session",
      timeoutMs: 1_000,
    });
    expect(consultParams.abortSignal.aborted).toBe(true);
    expect(registration.abortSignal.aborted).toBe(true);
  });

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
    let finishConsult = (_result: { text: string }) => {};
    mocks.consult.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finishConsult = resolve;
        }),
    );
    await startReadyFaceTimeTalkDriver();
    void mocks.sessionParams?.onToolCall({
      itemId: "item-reset",
      callId: "consult-reset",
      name: "openclaw_agent_consult",
      args: { question: "old" },
    });
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
    mocks.bridge.connect.mockResolvedValue();
    let finishConsult = (_result: { text: string }) => {};
    mocks.consult.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finishConsult = resolve;
        }),
    );
    await startReadyFaceTimeTalkDriver();

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Who am I?" },
    });
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

  it("silently closes a consult superseded by a new consult request", async () => {
    mocks.bridge.connect.mockResolvedValue();
    let finishConsult = (_result: { text: string }) => {};
    mocks.consult.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finishConsult = resolve;
        }),
    );
    mocks.consult.mockResolvedValueOnce({ text: "New answer." });
    await startReadyFaceTimeTalkDriver();

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Who am I?" },
    });
    void mocks.sessionParams?.onToolCall({
      itemId: "item-2",
      callId: "call-2",
      name: "openclaw_agent_consult",
      args: { question: "Do something else." },
    });

    await vi.waitFor(() =>
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith(
        "call-1",
        {
          status: "cancelled",
          message: "A new agent consult replaced this request before it completed.",
        },
        { suppressResponse: true },
      ),
    );
    finishConsult({ text: "Stale answer." });
    await Promise.resolve();
    await vi.waitFor(() =>
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith("call-2", {
        text: "New answer.",
      }),
    );
  });

  it("uses an unsuppressed terminal cancellation when the provider requires it", async () => {
    mocks.bridge.connect.mockResolvedValue();
    (
      mocks.bridge.bridge as { supportsToolResultSuppression?: boolean }
    ).supportsToolResultSuppression = false;
    mocks.consult.mockImplementationOnce(() => new Promise<{ text: string }>(() => {}));
    await startReadyFaceTimeTalkDriver();

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Who am I?" },
    });
    void mocks.sessionParams?.onToolCall({
      itemId: "item-2",
      callId: "call-2",
      name: "openclaw_agent_consult",
      args: { question: "Actually, do something else." },
    });

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
    mocks.bridge.connect.mockResolvedValue();
    mocks.bridge.submitToolResult.mockRejectedValueOnce(new Error("submission failed"));
    mocks.consult.mockImplementationOnce(() => new Promise<{ text: string }>(() => {}));
    const onFailure = vi.fn(async () => true);
    await startReadyFaceTimeTalkDriver(startParams({ onFailure }));

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Who am I?" },
    });
    void mocks.sessionParams?.onToolCall({
      itemId: "item-2",
      callId: "call-2",
      name: "openclaw_agent_consult",
      args: { question: "Actually, do something else." },
    });

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(new Error("submission failed")));
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it.each(["answer", "backend error", "working", "unknown tool", "recovery error"])(
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
    { settlement: "accepted", transition: "replacement" },
    { settlement: "rejected", transition: "replacement" },
  ])(
    "settles $settlement delivery correctly after $transition",
    async ({ settlement, transition }) => {
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
          }),
      );
      const onFailure = vi.fn(async () => true);
      const driver = await startReadyFaceTimeTalkDriver(startParams({ onFailure }));
      void mocks.sessionParams?.onToolCall({
        itemId: "item-delivery",
        callId: "call-delivery",
        name: "openclaw_agent_consult",
        args: { question: "Check my calendar." },
      });
      await vi.waitFor(() => expect(mocks.bridge.submitToolResult).toHaveBeenCalledOnce());
      if (transition === "close") {
        await driver.close("carrier-ended");
      } else {
        await mocks.sessionParams?.onToolCall({
          itemId: "item-replacement",
          callId: "call-replacement",
          name: "openclaw_agent_consult",
          args: { question: "Check my reminders instead." },
        });
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
      const acceptedResult = expect.arrayContaining([
        expect.objectContaining({ type: "tool.result", callId: "call-delivery" }),
      ]);
      if (transition === "replacement" && settlement === "accepted") {
        expect(driver.recentTalkEvents).toEqual(acceptedResult);
      } else {
        expect(driver.recentTalkEvents).not.toEqual(acceptedResult);
      }
    },
  );

  it("keeps a consult alive through VAD noise and its originating transcript", async () => {
    let finishConsult = (_result: { text: string }) => {};
    mocks.consult.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finishConsult = resolve;
        }),
    );
    await startReadyFaceTimeTalkDriver();

    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "input_audio_buffer.speech_started",
    });
    void mocks.sessionParams?.onToolCall({
      itemId: "item-calendar",
      callId: "call-calendar",
      name: "openclaw_agent_consult",
      args: { question: "What is on my calendar?" },
    });
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledOnce());
    const consultParams = mocks.consult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };

    mocks.sessionParams?.onTranscript?.("user", "What is on my calendar?", true);
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "input_audio_buffer.speech_started",
    });
    mocks.sessionParams?.onTranscript?.("user", "   ", true);

    expect(consultParams.abortSignal.aborted).toBe(false);
    expect(mocks.bridge.submitToolResult).not.toHaveBeenCalled();

    finishConsult({ text: "Calendar answer." });
    await vi.waitFor(() =>
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith("call-calendar", {
        text: "Calendar answer.",
      }),
    );
  });

  it("routes the main session key to the configured default agent", async () => {
    mocks.bridge.connect.mockResolvedValue();
    mocks.consult.mockResolvedValueOnce({ text: "I know my SOUL.md." });
    await startReadyFaceTimeTalkDriver(
      startParams({
        fullConfig: {
          agents: { list: [{ id: "lobster", default: true }] },
        },
      }),
    );

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Can you read SOUL.md?" },
    });

    await vi.waitFor(() =>
      expect(mocks.consult).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "lobster",
          sessionKey: "agent:lobster:facetime:call-1",
          spawnedBy: "agent:lobster:main",
          contextMode: "fork",
          senderId: "caller@example.com",
          senderIsOwner: true,
          messageProvider: "voice",
          lane: "facetime:call-1",
          thinkLevel: "off",
          extraSystemPrompt: expect.stringContaining(
            "configured owner/user described by this agent's workspace context",
          ),
        }),
      ),
    );
    expect(mocks.consult.mock.calls[0]?.[0].extraSystemPrompt).toContain("answer immediately");
  });

  it("normalizes FaceTime UUID casing for one consult session and lane", async () => {
    mocks.bridge.connect.mockResolvedValue();
    mocks.consult.mockResolvedValueOnce({ text: "Done." });
    await startReadyFaceTimeTalkDriver(
      startParams({
        callUUID: "17BC43FD-5800-4B54-86DB-698C49253C42",
        fullConfig: {
          agents: { list: [{ id: "lobster", default: true }] },
        },
      }),
    );

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Check my calendar." },
    });

    await vi.waitFor(() =>
      expect(mocks.consult).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:lobster:facetime:17bc43fd-5800-4b54-86db-698c49253c42",
          lane: "facetime:17bc43fd-5800-4b54-86db-698c49253c42",
          runIdPrefix: "facetime:17bc43fd-5800-4b54-86db-698c49253c42",
        }),
      ),
    );
  });
});
