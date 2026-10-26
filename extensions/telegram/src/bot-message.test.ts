import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramMessageProcessor } from "./bot-message.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  runWithTelegramUpdateProcessingFrame,
  runWithTelegramSpooledReplayUpdate,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
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

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  danger: (message: string) => message,
  sleepWithAbort,
}));

vi.mock("./bot-message-context.js", () => ({ buildTelegramMessageContext }));

vi.mock("./bot-message-dispatch.js", () => ({ dispatchTelegramMessage }));

type TelegramMessageProcessorTurnContext = Parameters<
  ReturnType<typeof createTelegramMessageProcessor>
>[0]["turnContext"];

describe("telegram bot message processor", () => {
  beforeEach(() => {
    buildTelegramMessageContext.mockReset().mockResolvedValue(createMessageContext());
    dispatchTelegramMessage.mockClear();
    detachedWork.run.mockClear();
    detachedWork.tasks.length = 0;
    sleepWithAbort.mockReset().mockResolvedValue(undefined);
  });

  const baseTurnContext = {
    cfg: {},
    telegramCfg: {},
  } satisfies TelegramMessageProcessorTurnContext;

  const baseDeps = {
    bot: {},
    account: {},
    runtime: {},
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  async function processSampleMessage(
    processMessage: ReturnType<typeof createTelegramMessageProcessor>,
    turnContext?: Partial<TelegramMessageProcessorTurnContext>,
    primaryCtxOverrides: Record<string, unknown> = {},
    options: Parameters<typeof processMessage>[0]["options"] = {},
  ) {
    return await processMessage({
      ctx: {
        message: { chat: { id: 123, type: "private", title: "chat" }, message_id: 456 },
        ...primaryCtxOverrides,
      } as unknown as Parameters<typeof processMessage>[0]["ctx"],
      allMedia: [],
      storeAllowFrom: [],
      turnContext: {
        ...turnContext,
        cfg: turnContext?.cfg ?? baseTurnContext.cfg,
        telegramCfg: turnContext?.telegramCfg ?? baseTurnContext.telegramCfg,
      },
      options,
    });
  }

  function processIsolatedReplay(turnContext?: Partial<TelegramMessageProcessorTurnContext>) {
    return processSampleMessage(
      createTelegramMessageProcessor(baseDeps),
      turnContext,
      {},
      { spooledReplay: true, isolateSpooledReplaySettlement: true },
    );
  }

  function observeParticipant(onSettle: (result: TelegramMessageProcessingResult) => void) {
    const participant = expectDefined(
      createTelegramSpooledReplayDeferredParticipant("test:observed-replay"),
      "spooled replay participant",
    );
    const settle = participant.settle;
    participant.settle = (result) => {
      onSettle(result);
      settle(result);
    };
  }

  async function replaySample(
    turnContext?: Partial<TelegramMessageProcessorTurnContext>,
    onSettle?: (result: TelegramMessageProcessingResult) => void,
    isolated = false,
  ) {
    const update = { update_id: 123458 };
    return runWithTelegramSpooledReplayUpdate(update, async () => {
      if (onSettle) {
        observeParticipant(onSettle);
      }
      return processSampleMessage(
        createTelegramMessageProcessor(baseDeps),
        turnContext,
        { update },
        isolated ? { spooledReplay: true, isolateSpooledReplaySettlement: true } : {},
      );
    });
  }

  function createDispatchFailureHarness(
    context: Record<string, unknown>,
    sendMessage: ReturnType<typeof vi.fn>,
  ) {
    const dispatchError = new Error("dispatch exploded");
    buildTelegramMessageContext.mockResolvedValue(createMessageContext(context));
    dispatchTelegramMessage.mockRejectedValue(dispatchError);
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    return { processMessage, dispatchError };
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
    expect(
      dispatchTelegramMessage.mock.calls.map(([params]) => [
        params.cfg,
        params.telegramCfg,
        params.replyToMode,
        params.streamMode,
        params.textLimit,
      ]),
    ).toEqual([
      [nextCfg, nextTelegramCfg, "off", "off", 1000],
      [turnCfg, turnTelegramCfg, "first", "partial", 3000],
    ]);
  });

  it("runs the dispatch-start lifecycle after context creation and before dispatch", async () => {
    const onDispatchStart = vi.fn(async () => undefined);

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toEqual({
      kind: "completed",
    });

    expect(onDispatchStart).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(onDispatchStart.mock.invocationCallOrder[0]!).toBeLessThan(
      dispatchTelegramMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("does not run the dispatch-start lifecycle when no context is produced", async () => {
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(null);

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toEqual({
      kind: "skipped",
    });

    expect(onDispatchStart).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it.each([
    { threadId: 456, blocked: false, params: { message_thread_id: 456 } },
    { threadId: 1, blocked: false, params: undefined },
    { threadId: undefined, blocked: true, params: undefined },
  ])(
    "delivers fallback for thread $threadId (blocked=$blocked)",
    async ({ threadId, blocked, params }) => {
      const sendMessage = vi.fn();
      if (blocked) {
        sendMessage.mockRejectedValue(new Error("blocked by user"));
      } else {
        sendMessage.mockResolvedValue(undefined);
      }
      const { processMessage, dispatchError } = createDispatchFailureHarness(
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
        params,
      );
    },
  );

  it("finalizes spooled adoption before settling the ingress participant", async () => {
    const events: string[] = [];
    const finalizeSpooledReplayResult = vi.fn(
      async (
        result: TelegramMessageProcessingResult,
        phase: "adopted" | "terminal",
      ): Promise<TelegramMessageProcessingResult> => {
        events.push(`finalizer:${phase}`);
        return result;
      },
    );
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      await turnAdoptionLifecycle?.onAdopted();
      return { kind: "completed" };
    });
    const replay = await replaySample({ finalizeSpooledReplayResult }, (result) => {
      events.push(`participant:${result.kind}`);
    });

    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
    expect(events).toEqual(["finalizer:adopted", "participant:completed"]);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(1);
  });

  it("owns spooled dispatch through draft cleanup and fallback delivery after adoption", async () => {
    const cleanup = createDeferred<void>();
    const draftCleaned = createDeferred<void>();
    const fallback = createDeferred<void>();
    const finished = createDeferred<void>();
    const deliverFallback = vi.fn(async () => {});
    const completed = vi.fn();
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
    let completion: Promise<unknown> | undefined;
    try {
      await expect(processIsolatedReplay()).resolves.toEqual({ kind: "completed" });
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
    const refusal = new Error("Gateway is restarting");
    detachedWork.run.mockRejectedValueOnce(refusal);
    await expect(processIsolatedReplay()).resolves.toEqual({
      kind: "failed-retryable",
      error: refusal,
    });
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
    await expect(
      processIsolatedReplay({
        finalizeSpooledReplayResult,
        spooledReplayAbortSignal: abortController.signal,
      }),
    ).resolves.toEqual({ kind: "failed-retryable", error: timeoutError });
    expect(finalizeSpooledReplayResult).toHaveBeenCalledWith(
      { kind: "failed-retryable", error: timeoutError },
      "terminal",
    );
  });

  it("retries active-steer durable replay protection through multiple transient failures", async () => {
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
    const replay = await replaySample({
      finalizeSpooledReplayResult,
      completeSpooledReplayAfterIrrevocableAdoption,
    });

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
    const processing = processIsolatedReplay({
      finalizeSpooledReplayResult,
      completeSpooledReplayAfterIrrevocableAdoption,
      spooledReplayAbortSignal: outerAbortController.signal,
    });

    await expect(processing).resolves.toEqual({
      kind: "failed-retryable",
      error: cancellationError,
    });
    expect(completeSpooledReplayAfterIrrevocableAdoption).toHaveBeenCalledTimes(1);
    expect(sleepWithAbort).toHaveBeenCalledTimes(1);
  });

  it("retries deferred adoption after finalization rejects without settling ingress", async () => {
    const finalizerError = new Error("dedupe commit failed");
    const events: string[] = [];
    const finalizeSpooledReplayResult = vi
      .fn(
        async (
          result: TelegramMessageProcessingResult,
          phase: "adopted" | "terminal",
        ): Promise<TelegramMessageProcessingResult> => {
          events.push(`finalizer:${phase}`);
          return result;
        },
      )
      .mockRejectedValueOnce(finalizerError);
    let participantSettles = 0;
    let settledAfterFirstAdmission = false;
    const admissionErrors: unknown[] = [];
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      turnAdoptionLifecycle?.onDeferred?.();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await turnAdoptionLifecycle?.onAdopted();
          admissionErrors.push(undefined);
        } catch (error) {
          admissionErrors.push(error);
        }
        if (attempt === 0) {
          settledAfterFirstAdmission = participantSettles > 0;
        }
      }
      return { kind: "completed" };
    });
    const replay = await replaySample({ finalizeSpooledReplayResult }, (result) => {
      events.push(`participant:${result.kind}`);
      participantSettles += 1;
    });

    expect(admissionErrors).toEqual([finalizerError, undefined, undefined]);
    expect(settledAfterFirstAdmission).toBe(false);
    expect(events).toEqual(["finalizer:adopted", "participant:completed"]);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(2);
    expect(participantSettles).toBe(1);
    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
  });

  it("keeps isolated retry settlement separate from the outer spool participant", async () => {
    const retryError = new Error("retry this attempt");
    dispatchTelegramMessage.mockResolvedValueOnce({ kind: "failed-retryable", error: retryError });
    let outerSettles = 0;
    const replay = await replaySample(
      undefined,
      () => {
        outerSettles += 1;
      },
      true,
    );

    expect(replay.value).toEqual({ kind: "failed-retryable", error: retryError });
    expect(outerSettles).toBe(0);
    const outerParticipant = replay.deferredWork;
    expect(outerParticipant).toBeDefined();
    outerParticipant?.settle({ kind: "skipped" });
    await expect(outerParticipant?.task).resolves.toEqual({ kind: "skipped" });
  });

  it("aborts an isolated queued retry when its outer spool owner is cancelled", async () => {
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
    const processing = processIsolatedReplay({
      spooledReplayAbortSignal: outerAbortController.signal,
    });
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
