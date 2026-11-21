import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../src/process/gateway-work-admission.js";
import { resolveFaceTimeConfig } from "../src/config.js";
import {
  mocks,
  resetTalkDriverMocks,
  startParams,
  startReadyFaceTimeTalkDriver,
} from "./talk-driver.test-support.js";

const forkSessionEntryFromParent = vi.hoisted(() =>
  vi.fn(async () => ({
    status: "skipped" as const,
    reason: "decision-skip" as const,
    sessionEntry: { sessionId: "", updatedAt: 1 },
  })),
);

// The real fork writes through the sqlite-backed session store, which is not
// available inside vitest worker threads; the admission behavior under test
// does not depend on the fork decision.
vi.mock("../../../src/auto-reply/reply/session-fork.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/auto-reply/reply/session-fork.js")>();
  return { ...actual, forkSessionEntryFromParent };
});

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

  it("cancels a superseded consult without aborting its successor on late completion", async () => {
    mocks.consult.mockImplementation(() => new Promise<{ text: string }>(() => {}));
    const finishFirst = deferConsult();
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
    };
    const second = mocks.consult.mock.calls[1]?.[0] as typeof first;

    expect(first.abortSignal.aborted).toBe(true);
    expect(second.abortSignal.aborted).toBe(false);
    finishFirst({ text: "Superseded answer." });
    await Promise.resolve();
    expect(second.abortSignal.aborted).toBe(false);
    expect(mocks.bridge.submitToolResult).not.toHaveBeenCalledWith("consult-a", {
      text: "Superseded answer.",
    });
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
        const consultParams = mocks.consult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };
        expect(consultParams.abortSignal.aborted).toBe(false);
        await driver.close("carrier-ended");
        expect(consultParams.abortSignal.aborted).toBe(true);
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

  it("routes one normalized FaceTime session to the sole configured agent", async () => {
    mocks.consult.mockResolvedValueOnce({ text: "I know my SOUL.md." });
    await startReadyFaceTimeTalkDriver(
      startParams({
        callUUID: "17BC43FD-5800-4B54-86DB-698C49253C42",
        fullConfig: {
          agents: { entries: { lobster: {} } },
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
    // Owner status comes from commands.ownerAllowFrom in the host, never from this plugin.
    expect(mocks.consult.mock.calls[0]?.[0]).not.toHaveProperty("senderIsOwner");
  });
});

describe("FaceTime talk driver consult root admission", () => {
  let actualConsultRealtimeVoiceAgent: (
    params: Record<string, unknown>,
  ) => Promise<{ text: string; yielded?: true }>;

  beforeAll(async () => {
    const actualRealtimeVoice = await vi.importActual<{
      consultRealtimeVoiceAgent: (
        params: Record<string, unknown>,
      ) => Promise<{ text: string; yielded?: true }>;
    }>("openclaw/plugin-sdk/realtime-voice");
    actualConsultRealtimeVoiceAgent = actualRealtimeVoice.consultRealtimeVoiceAgent;
  });

  function createConsultAgentRuntime() {
    const sessionStore: Record<string, Record<string, unknown>> = {};
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: "17 times 23 is 391." }],
      meta: {},
    }));
    return {
      runEmbeddedAgent,
      runtime: {
        runEmbeddedAgent,
        resolveAgentDir: vi.fn(() => "/tmp/facetime-agent"),
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/facetime-workspace"),
        ensureAgentWorkspace: vi.fn(async () => {}),
        resolveAgentTimeoutMs: vi.fn(() => 30_000),
        session: {
          resolveStorePath: vi.fn(() => "/tmp/facetime-sessions.json"),
          getSessionEntry: vi.fn(
            ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey],
          ),
          getSessionEntryAsync: vi.fn(
            async ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey],
          ),
          prepareSessionEntryPatch: vi.fn(
            async ({
              sessionKey,
              fallbackEntry,
              prepare,
            }: {
              sessionKey: string;
              fallbackEntry: Record<string, unknown>;
              prepare: (
                entry: Record<string, unknown>,
              ) => Promise<Record<string, unknown>> | Record<string, unknown>;
            }) => {
              const current = sessionStore[sessionKey] ?? fallbackEntry;
              const patch = await prepare({ ...current });
              const next = { ...current, ...patch };
              sessionStore[sessionKey] = next;
              return next;
            },
          ),
        },
      },
    };
  }

  beforeEach(() => {
    resetTalkDriverMocks();
    resetGatewayWorkAdmission();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
  });

  it("answers a consult issued from a released plugin-service root", async () => {
    const agentRuntime = createConsultAgentRuntime();
    mocks.consult.mockImplementationOnce((consultParams) =>
      actualConsultRealtimeVoiceAgent(consultParams as never),
    );
    const logger = { warn: vi.fn() };
    const params = startParams({
      config: resolveFaceTimeConfig({ ownerHandles: ["caller@example.com"] }),
      runtime: { agent: agentRuntime.runtime } as never,
      logger: logger as never,
    });

    const serviceRoot = tryBeginGatewayRootWorkAdmission("facetime:plugin-service");
    expect(serviceRoot).not.toBeNull();
    const start = Promise.withResolvers<void>();
    let toolCall: Promise<unknown> | undefined;
    // Mirrors the reported bug: the realtime bridge and its tool-call callback are
    // created while the plugin service's startup root is still live, and the voice
    // model only issues the consult after that root has released.
    await serviceRoot!.run(async () => {
      await startReadyFaceTimeTalkDriver(params);
      toolCall = (async () => {
        await start.promise;
        return consult("item-1", "call-1", "What is 17 times 23?");
      })();
    });
    serviceRoot!.release();
    start.resolve();
    await toolCall;

    // The real consult runtime loads its session lifecycle lazily; allow for that.
    await vi.waitFor(
      () =>
        expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith("call-1", {
          text: "17 times 23 is 391.",
        }),
      { timeout: 15_000 },
    );
    expect(agentRuntime.runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
});
