// Telegram tests cover bot message plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramMediaRef } from "./bot-message-context.js";
import { createTelegramMessageProcessor } from "./bot-message.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  runWithTelegramUpdateProcessingFrame,
  runWithTelegramSpooledReplayUpdate,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const verboseLog = vi.hoisted(() => vi.fn());
const detachedWork = vi.hoisted(() => {
  const tasks: Promise<unknown>[] = [];
  return { tasks, run: vi.fn<(run: () => Promise<unknown>) => Promise<unknown>>() };
});

vi.mock("openclaw/plugin-sdk/webhook-request-guards", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/webhook-request-guards")>();
  return {
    ...actual,
    runDetachedWebhookWork: detachedWork.run.mockImplementation((run) => {
      const task = actual.runDetachedWebhookWork(run);
      detachedWork.tasks.push(task);
      return task;
    }),
  };
});
const sleepWithAbort = vi.hoisted(() =>
  vi.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>(async () => undefined),
);
const upsertChannelPairingRequest = vi.hoisted(() =>
  vi.fn(async () => ({ code: "PAIRCODE", created: true })),
);

function requireInvocationOrder(mock: { invocationCallOrder: number[] }, context: string): number {
  return expectDefined(mock.invocationCallOrder[0], context);
}

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  computeBackoff: vi.fn((_policy: unknown, attempt: number) => attempt),
  danger: (message: string) => message,
  logVerbose: verboseLog,
  shouldLogVerbose: () => false,
  sleepWithAbort,
}));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

type TelegramMessageProcessorTurnContext = Parameters<
  ReturnType<typeof createTelegramMessageProcessor>
>[0]["turnContext"];

function unexpectedBotDependency(): never {
  throw new Error("Message processor fixtures mock context construction and dispatch");
}

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  recordInboundSession: unexpectedBotDependency,
  upsertChannelPairingRequest,
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-activity-runtime")>()),
  recordChannelActivity: unexpectedBotDependency,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  buildChannelInboundEventContext: unexpectedBotDependency,
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveInboundLastRouteSessionKey: unexpectedBotDependency,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>()),
  resolvePinnedMainDmOwnerFromAllowlist: unexpectedBotDependency,
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  readSessionUpdatedAtAsync: unexpectedBotDependency,
  readAmbientTranscriptWatermarkAsync: unexpectedBotDependency,
  resolveAmbientTranscriptWatermarkKey: unexpectedBotDependency,
  resolveStorePath: unexpectedBotDependency,
}));

describe("telegram bot message processor", () => {
  beforeEach(() => {
    buildTelegramMessageContext.mockClear();
    dispatchTelegramMessage.mockClear();
    verboseLog.mockClear();
    detachedWork.run.mockClear();
    detachedWork.tasks.length = 0;
    sleepWithAbort.mockReset().mockResolvedValue(undefined);
    upsertChannelPairingRequest.mockClear();
  });

  const baseTurnContext = {
    cfg: {},
    telegramCfg: {},
  } satisfies TelegramMessageProcessorTurnContext;

  const baseDeps = {
    bot: {},
    account: {},
    historyLimit: 0,
    dmPolicy: {},
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "none",
    logger: {},
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({}),
    runtime: {},
    replyToMode: "auto",
    streamMode: "partial",
    textLimit: 4096,
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  async function processSampleMessage(
    processMessage: ReturnType<typeof createTelegramMessageProcessor>,
    turnContext?: Partial<TelegramMessageProcessorTurnContext>,
    primaryCtxOverrides: Record<string, unknown> = {},
    options: Parameters<typeof processMessage>[0]["options"] = {},
    allMedia: Parameters<typeof processMessage>[0]["allMedia"] = [],
  ) {
    return await processMessage({
      ctx: {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
        },
        ...primaryCtxOverrides,
      } as unknown as Parameters<typeof processMessage>[0]["ctx"],
      allMedia,
      storeAllowFrom: [],
      turnContext: {
        ...turnContext,
        cfg: turnContext?.cfg ?? baseTurnContext.cfg,
        telegramCfg: turnContext?.telegramCfg ?? baseTurnContext.telegramCfg,
      },
      options,
    });
  }

  function createDispatchFailureHarness(
    context: Record<string, unknown>,
    sendMessage: ReturnType<typeof vi.fn>,
  ) {
    const runtimeError = vi.fn();
    const dispatchError = new Error("dispatch exploded");
    buildTelegramMessageContext.mockResolvedValue(createMessageContext(context));
    dispatchTelegramMessage.mockRejectedValue(dispatchError);
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    return { processMessage, runtimeError, dispatchError };
  }

  function createMessageContext(context: Record<string, unknown> = {}) {
    return {
      cfg: {},
      chatId: 123,
      ctxPayload: {
        From: "telegram:123",
        To: "telegram:123",
        ChatType: "direct",
        RawBody: "hello there",
      },
      primaryCtx: { me: { username: "openclaw_bot" } },
      route: { sessionKey: "agent:main:main" },
      sendTyping: vi.fn().mockResolvedValue(undefined),
      ...context,
    };
  }

  it("keeps delivery settings on a held turn while the next turn uses new policy", async () => {
    const held = createDeferred<void>();
    const contextStarted = createDeferred<void>();
    const turnTelegramCfg = {
      dmPolicy: "open" as const,
      allowFrom: ["*"],
      replyToMode: "first" as const,
      streaming: { mode: "partial" as const },
      textChunkLimit: 3000,
    };
    const nextTelegramCfg = {
      dmPolicy: "allowlist" as const,
      allowFrom: ["43"],
      replyToMode: "off" as const,
      streaming: { mode: "off" as const },
      textChunkLimit: 1000,
    };
    const turnCfg = { channels: { telegram: turnTelegramCfg } };
    const nextCfg = { channels: { telegram: nextTelegramCfg } };
    buildTelegramMessageContext.mockImplementationOnce(async (params) => {
      contextStarted.resolve();
      await held.promise;
      return createMessageContext({ cfg: params.cfg });
    });
    buildTelegramMessageContext.mockImplementationOnce(async (params) =>
      createMessageContext({ cfg: params.cfg }),
    );

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      account: { accountId: "default" },
    });
    const first = processSampleMessage(processMessage, {
      cfg: turnCfg,
      telegramCfg: turnTelegramCfg,
    });
    await contextStarted.promise;
    try {
      await processSampleMessage(processMessage, { cfg: nextCfg, telegramCfg: nextTelegramCfg });
    } finally {
      held.resolve();
    }
    await expect(first).resolves.toEqual({ kind: "completed" });

    expect(buildTelegramMessageContext.mock.calls.map(([params]) => params.allowFrom)).toEqual([
      ["*"],
      ["43"],
    ]);
    expect(dispatchTelegramMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cfg: nextCfg,
        telegramCfg: nextTelegramCfg,
        replyToMode: "off",
        streamMode: "off",
        textLimit: 1000,
      }),
    );
    expect(dispatchTelegramMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cfg: turnCfg,
        telegramCfg: turnTelegramCfg,
        replyToMode: "first",
        streamMode: "partial",
        textLimit: 3000,
      }),
    );
  });

  it.each([true, false])(
    "runs dispatch-start only with context (context=%s)",
    async (hasContext) => {
      const onDispatchStart = vi.fn(async () => undefined);
      buildTelegramMessageContext.mockResolvedValue(hasContext ? createMessageContext() : null);
      const processMessage = createTelegramMessageProcessor(baseDeps);
      await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toEqual({
        kind: hasContext ? "completed" : "skipped",
      });
      expect(onDispatchStart).toHaveBeenCalledTimes(Number(hasContext));
      expect(dispatchTelegramMessage).toHaveBeenCalledTimes(Number(hasContext));
      if (hasContext) {
        expect(
          requireInvocationOrder(onDispatchStart.mock, "dispatch-start invocation"),
        ).toBeLessThan(
          requireInvocationOrder(dispatchTelegramMessage.mock, "message dispatch invocation"),
        );
      }
    },
  );

  it("dispatches media context without logging message content", async () => {
    const body = "private Telegram image caption";
    const media: TelegramMediaRef = {
      path: "/tmp/photo.jpg",
      contentType: "image/jpeg",
      kind: "image",
    };
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        ctxPayload: {
          From: "telegram:group:-100",
          To: "telegram:group:-100",
          ChatType: "group",
          RawBody: body,
        },
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, undefined, {}, {}, [media])).resolves.toEqual(
      { kind: "completed" },
    );

    expect(buildTelegramMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({ allMedia: [media] }),
    );
    expect(dispatchTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          ctxPayload: expect.objectContaining({ RawBody: body }),
        }),
      }),
    );
    expect(JSON.stringify(verboseLog.mock.calls)).not.toContain(body);
  });

  it.each([
    [456, { message_thread_id: 456 }, false],
    [1, undefined, false],
    [undefined, undefined, true],
  ] as const)(
    "handles dispatch failure fallback (topic=%s, params=%j, sendFailure=%s)",
    async (threadId, threadParams, sendFailure) => {
      const sendMessage = vi.fn();
      if (sendFailure) {
        sendMessage.mockRejectedValue(new Error("blocked by user"));
      } else {
        sendMessage.mockResolvedValue(undefined);
      }
      const { processMessage, runtimeError, dispatchError } = createDispatchFailureHarness(
        threadId === undefined ? {} : { threadSpec: { id: threadId, scope: "forum" } },
        sendMessage,
      );
      await expect(processSampleMessage(processMessage)).resolves.toEqual({
        kind: "failed-retryable",
        error: dispatchError,
      });
      expect(sendMessage).toHaveBeenCalledWith(
        123,
        "Something went wrong while processing your request. Please try again.",
        threadParams,
      );
      expect(runtimeError).toHaveBeenCalledWith(
        "telegram message processing failed: Error: dispatch exploded",
      );
    },
  );

  it.each([undefined, "queue-cap-old", "queue-cap-new"] as const)(
    "settles a spooled source after its durable receipt: %s",
    async (reason) => {
      buildTelegramMessageContext.mockResolvedValue(createMessageContext());
      const events: string[] = [];
      const receipt = createDeferred<void>();
      const receiptStarted = createDeferred<void>();
      const callbackStarted = createDeferred<void>();
      const receiptError = reason === "queue-cap-new" ? new Error("receipt failed") : undefined;
      const result: TelegramMessageProcessingResult = reason
        ? { kind: "dropped", reason }
        : { kind: "completed" };
      const finalizeSpooledReplayResult = vi.fn(async () => {
        events.push("finalizer");
        return result;
      });
      const settleReceipt = () => {
        events.push("drain");
        receiptStarted.resolve();
        return receipt.promise;
      };
      let sourceResult: Promise<unknown> | undefined;
      dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
        const settlement = reason
          ? turnAdoptionLifecycle.onDropped(reason)
          : turnAdoptionLifecycle.onAdopted();
        sourceResult = Promise.resolve(settlement).then(
          () => events.push("source"),
          (error: unknown) => error,
        );
        callbackStarted.resolve();
        await settlement;
        return { kind: "completed" };
      });
      const update = { update_id: 123458 };
      const processing = runWithTelegramSpooledReplayUpdate(
        update,
        async () => {
          const participant = expectDefined(
            createTelegramSpooledReplayDeferredParticipant("test:receipt"),
            "spooled participant",
          );
          const settle = participant.settle;
          participant.settle = (outcome) => {
            events.push(`participant:${outcome.kind}`);
            settle(outcome);
          };
          return await processSampleMessage(
            createTelegramMessageProcessor(baseDeps),
            { finalizeSpooledReplayResult },
            { update },
          );
        },
        {
          abortSignal: new AbortController().signal,
          onAdopted: settleReceipt,
          onDropped: settleReceipt,
          onDeferred: () => {},
          onAbandoned: () => {},
        },
      );
      try {
        await callbackStarted.promise;
        const source = expectDefined(sourceResult, "source settlement");
        expect(
          await Promise.race([
            receiptStarted.promise.then(() => "receipt"),
            source.then(() => "source"),
          ]),
        ).toBe("receipt");
        expect(events).toEqual(["finalizer", `participant:${result.kind}`, "drain"]);
        if (receiptError) {
          receipt.reject(receiptError);
          expect(await sourceResult).toBe(receiptError);
        } else {
          receipt.resolve();
          await sourceResult;
          expect(events.at(-1)).toBe("source");
        }
        const replay = await processing;
        expect(replay.value).toEqual(result);
        await expect(replay.deferredWork?.task).resolves.toEqual(result);
        expect(finalizeSpooledReplayResult).toHaveBeenCalledOnce();
      } finally {
        receipt.resolve();
        await processing;
      }
    },
  );

  it("owns spooled dispatch through draft cleanup and fallback delivery after adoption", async () => {
    const cleanup = createDeferred<void>();
    const draftCleaned = createDeferred<void>();
    const fallback = createDeferred<void>();
    const finished = createDeferred<void>();
    const deliverFallback = vi.fn(async () => {});
    const completed = vi.fn();
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      try {
        await turnAdoptionLifecycle.onAdopted();
        // The core dispatch has returned, but Telegram still owns these awaited phases.
        await cleanup.promise;
        draftCleaned.resolve();
        await fallback.promise;
        await deliverFallback();
        return { kind: "completed" };
      } finally {
        finished.resolve();
      }
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    let completion: Promise<unknown> | undefined;
    try {
      await expect(
        processSampleMessage(
          processMessage,
          undefined,
          {},
          {
            spooledReplay: true,
            isolateSpooledReplaySettlement: true,
          },
        ),
      ).resolves.toEqual({ kind: "completed" });
      const task = expectDefined(detachedWork.tasks[0], "detached dispatch task");
      completion = task.then(completed);
      expect(completed).not.toHaveBeenCalled();
      expect(deliverFallback).not.toHaveBeenCalled();
      cleanup.resolve();
      await draftCleaned.promise;
      expect(completed).not.toHaveBeenCalled();
      expect(deliverFallback).not.toHaveBeenCalled();
      fallback.resolve();
      await completion;
      expect(deliverFallback).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
    } finally {
      cleanup.resolve();
      fallback.resolve();
      await finished.promise;
      await completion;
    }
  });

  it("settles a spooled participant retryably when detached admission is refused", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const refusal = new Error("Gateway is restarting");
    detachedWork.run.mockRejectedValueOnce(refusal);
    await expect(
      processSampleMessage(
        processMessage,
        undefined,
        {},
        {
          spooledReplay: true,
          isolateSpooledReplaySettlement: true,
        },
      ),
    ).resolves.toEqual({ kind: "failed-retryable", error: refusal });
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("keeps a spooled replay completed when dispatch fails after adoption", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const lateError = new Error("late dispatch failure");
    const finalizeSpooledReplayResult = vi.fn(
      async (result: TelegramMessageProcessingResult): Promise<TelegramMessageProcessingResult> =>
        result,
    );
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      await turnAdoptionLifecycle?.onAdopted();
      return { kind: "failed-retryable", error: lateError };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 123459 };

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () =>
      processSampleMessage(processMessage, { finalizeSpooledReplayResult }, { update }),
    );

    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(1);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledWith({ kind: "completed" }, "adopted");
  });

  it("keeps a pre-adoption owner abort retryable when dispatch returns completed", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const timeoutError = new Error("handler-timeout");
    const abortController = new AbortController();
    const finalizeSpooledReplayResult = vi.fn(
      async (result: TelegramMessageProcessingResult): Promise<TelegramMessageProcessingResult> =>
        result,
    );
    dispatchTelegramMessage.mockImplementationOnce(async () => {
      abortController.abort(timeoutError);
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);

    await expect(
      processSampleMessage(
        processMessage,
        {
          finalizeSpooledReplayResult,
          spooledReplayAbortSignal: abortController.signal,
        },
        {},
        { spooledReplay: true, isolateSpooledReplaySettlement: true },
      ),
    ).resolves.toEqual({ kind: "failed-retryable", error: timeoutError });
    expect(finalizeSpooledReplayResult).toHaveBeenCalledWith(
      { kind: "failed-retryable", error: timeoutError },
      "terminal",
    );
  });

  it("retries active-steer durable replay protection through multiple transient failures", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const finalizerError = new Error("dedupe commit failed");
    const firstRetryError = new Error("first dedupe retry failed");
    const secondRetryError = new Error("second dedupe retry failed");
    const finalizeSpooledReplayResult = vi.fn(async () => {
      throw finalizerError;
    });
    const completeSpooledReplayAfterIrrevocableAdoption = vi
      .fn<() => Promise<TelegramMessageProcessingResult>>()
      .mockRejectedValueOnce(firstRetryError)
      .mockRejectedValueOnce(secondRetryError)
      .mockResolvedValue({ kind: "completed" });
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      await expect(turnAdoptionLifecycle?.onAdopted()).rejects.toBe(finalizerError);
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 1234592 };

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () =>
      processSampleMessage(
        processMessage,
        {
          finalizeSpooledReplayResult,
          completeSpooledReplayAfterIrrevocableAdoption,
        },
        { update },
      ),
    );

    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
    expect(completeSpooledReplayAfterIrrevocableAdoption).toHaveBeenCalledTimes(3);
    expect(completeSpooledReplayAfterIrrevocableAdoption.mock.calls).toEqual([
      [finalizerError],
      [firstRetryError],
      [secondRetryError],
    ]);
    expect(sleepWithAbort).toHaveBeenCalledTimes(2);
  });

  it("stops active-steer durable replay retries when the outer spool owner is cancelled", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const finalizerError = new Error("dedupe commit failed");
    const retryError = new Error("dedupe retry failed");
    const cancellationError = new Error("outer spool timeout");
    const outerAbortController = new AbortController();
    const finalizeSpooledReplayResult = vi.fn(async () => {
      throw finalizerError;
    });
    const completeSpooledReplayAfterIrrevocableAdoption = vi
      .fn<() => Promise<TelegramMessageProcessingResult>>()
      .mockRejectedValue(retryError);
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      await expect(turnAdoptionLifecycle?.onAdopted()).rejects.toBe(finalizerError);
      return { kind: "completed" };
    });
    sleepWithAbort.mockImplementationOnce(async (_delayMs, signal) => {
      outerAbortController.abort(cancellationError);
      if (signal?.aborted) {
        throw signal.reason;
      }
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);

    const processing = processSampleMessage(
      processMessage,
      {
        finalizeSpooledReplayResult,
        completeSpooledReplayAfterIrrevocableAdoption,
        spooledReplayAbortSignal: outerAbortController.signal,
      },
      {},
      { spooledReplay: true, isolateSpooledReplaySettlement: true },
    );

    await expect(processing).resolves.toEqual({
      kind: "failed-retryable",
      error: cancellationError,
    });
    expect(completeSpooledReplayAfterIrrevocableAdoption).toHaveBeenCalledTimes(1);
    expect(sleepWithAbort).toHaveBeenCalledTimes(1);
  });

  it("retries deferred adoption after finalization rejects without settling ingress", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const finalizerError = new Error("dedupe commit failed");
    const finalizeSpooledReplayResult = vi
      .fn(
        async (result: TelegramMessageProcessingResult): Promise<TelegramMessageProcessingResult> =>
          result,
      )
      .mockRejectedValueOnce(finalizerError);
    let participantSettles = 0;
    let settledAfterFirstAdmission = false;
    const admissionErrors: unknown[] = [];
    const admissionsDone = createDeferred<void>();
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      turnAdoptionLifecycle?.onDeferred?.();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        admissionErrors.push(
          await Promise.resolve()
            .then(() => turnAdoptionLifecycle.onAdopted())
            .catch((error: unknown) => error),
        );
        if (attempt === 0) {
          settledAfterFirstAdmission = participantSettles > 0;
        }
      }
      admissionsDone.resolve();
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 123460 };

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
      const participant = createTelegramSpooledReplayDeferredParticipant(
        "test:adoption-finalizer-retry",
      );
      if (!participant) {
        throw new Error("expected spooled replay participant");
      }
      const settle = participant.settle;
      participant.settle = (result) => {
        participantSettles += 1;
        settle(result);
      };
      return await processSampleMessage(
        processMessage,
        { finalizeSpooledReplayResult },
        { update },
      );
    });

    await admissionsDone.promise;
    expect(admissionErrors).toEqual([finalizerError, undefined, undefined]);
    expect(settledAfterFirstAdmission).toBe(false);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(2);
    expect(participantSettles).toBe(1);
    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
  });

  it("keeps isolated retry settlement separate from the outer spool participant", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const retryError = new Error("retry this attempt");
    dispatchTelegramMessage.mockResolvedValueOnce({
      kind: "failed-retryable",
      error: retryError,
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 123462 };
    let outerSettles = 0;

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
      const participant = createTelegramSpooledReplayDeferredParticipant("test:outer-retry");
      if (!participant) {
        throw new Error("expected spooled replay participant");
      }
      const settle = participant.settle;
      participant.settle = (result) => {
        outerSettles += 1;
        settle(result);
      };
      return await processSampleMessage(
        processMessage,
        undefined,
        { update },
        { spooledReplay: true, isolateSpooledReplaySettlement: true },
      );
    });

    expect(replay.value).toEqual({ kind: "failed-retryable", error: retryError });
    expect(outerSettles).toBe(0);
    const outerParticipant = replay.deferredWork;
    expect(outerParticipant).toBeDefined();
    outerParticipant?.settle({ kind: "skipped" });
    await expect(outerParticipant?.task).resolves.toEqual({ kind: "skipped" });
  });

  it("aborts an isolated queued retry when its outer spool owner is cancelled", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const outerAbortController = new AbortController();
    const { promise: deferred, resolve: markDeferred } = Promise.withResolvers<void>();
    let queuedAbortSignal: AbortSignal | undefined;
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      const turnAbortSignal = turnAdoptionLifecycle?.abortSignal;
      queuedAbortSignal = turnAbortSignal;
      turnAdoptionLifecycle?.onDeferred?.();
      markDeferred?.();
      if (!turnAbortSignal?.aborted) {
        await new Promise<void>((resolve) => {
          turnAbortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      await turnAdoptionLifecycle?.onAbandoned?.();
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);

    const processing = processSampleMessage(
      processMessage,
      { spooledReplayAbortSignal: outerAbortController.signal },
      {},
      { spooledReplay: true, isolateSpooledReplaySettlement: true },
    );
    await deferred;
    outerAbortController.abort(new Error("outer spool timeout"));

    await expect(processing).resolves.toEqual({
      kind: "failed-retryable",
      error: "turn-abandoned",
    });
    expect(queuedAbortSignal?.aborted).toBe(true);
  });

  it("does not record buffered spooled replay failures into the ambient update frame", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage, dispatchError } = createDispatchFailureHarness({}, sendMessage);

    const frame = await runWithTelegramUpdateProcessingFrame(async () =>
      processSampleMessage(processMessage, undefined, {}, { spooledReplay: true }),
    );

    expect(frame.value).toEqual({ kind: "failed-retryable", error: dispatchError });
    expect(frame.result).toBeUndefined();
  });
});
