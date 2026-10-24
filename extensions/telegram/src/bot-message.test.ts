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

function requireInvocationOrder(mock: { invocationCallOrder: number[] }, context: string): number {
  return expectDefined(mock.invocationCallOrder[0], context);
}

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  computeBackoff: vi.fn((_policy: unknown, attempt: number) => attempt),
  danger: (message: string) => message,
  sleepWithAbort,
}));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

type ProcessInput = Parameters<ReturnType<typeof createTelegramMessageProcessor>>[0];
type TurnContext = ProcessInput["turnContext"];

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
  } satisfies TurnContext;

  const baseDeps = {
    bot: {},
    account: {},
    logger: {},
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({}),
    runtime: {},
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  async function processSampleMessage(
    processMessage = createTelegramMessageProcessor(baseDeps),
    turnContext?: Partial<TurnContext>,
    primaryCtxOverrides: Record<string, unknown> = {},
    options: ProcessInput["options"] = {},
  ) {
    return await processMessage({
      ctx: {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
        },
        ...primaryCtxOverrides,
      } as unknown as ProcessInput["ctx"],
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

  const isolatedReplay = { spooledReplay: true, isolateSpooledReplaySettlement: true };
  const processIsolated = (turnContext?: Partial<TurnContext>) =>
    processSampleMessage(undefined, turnContext, {}, isolatedReplay);
  const passThroughFinalizer = () =>
    vi.fn(async (result: TelegramMessageProcessingResult) => result);
  async function replayMessage(
    turnContext?: Partial<TurnContext>,
    onSettle?: (result: TelegramMessageProcessingResult) => void,
    isolated = false,
  ) {
    const update = { update_id: 123459 };
    return runWithTelegramSpooledReplayUpdate(update, () => {
      if (onSettle) {
        const participant = expectDefined(
          createTelegramSpooledReplayDeferredParticipant("test:replay"),
          "replay participant",
        );
        const settle = participant.settle;
        participant.settle = (result) => {
          onSettle(result);
          settle(result);
        };
      }
      return processSampleMessage(
        undefined,
        turnContext,
        { update },
        isolated ? isolatedReplay : {},
      );
    });
  }
  async function expectCompletedReplay(replay: Awaited<ReturnType<typeof replayMessage>>) {
    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
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
      ctxPayload: {},
      primaryCtx: {},
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
      dispatchTelegramMessage.mock.calls.map(([p]) => [
        p.cfg,
        p.telegramCfg,
        p.replyToMode,
        p.streamMode,
        p.textLimit,
      ]),
    ).toEqual([
      [nextCfg, nextTelegramCfg, "off", "off", 1000],
      [turnCfg, turnTelegramCfg, "first", "partial", 3000],
    ]);
  });

  it("runs the dispatch-start lifecycle after context creation and before dispatch", async () => {
    const onDispatchStart = vi.fn(async () => undefined);

    await expect(processSampleMessage(undefined, { onDispatchStart })).resolves.toEqual({
      kind: "completed",
    });

    expect(onDispatchStart).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(requireInvocationOrder(onDispatchStart.mock, "dispatch-start invocation")).toBeLessThan(
      requireInvocationOrder(dispatchTelegramMessage.mock, "message dispatch invocation"),
    );
  });

  it("does not run the dispatch-start lifecycle when no context is produced", async () => {
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(null);

    await expect(processSampleMessage(undefined, { onDispatchStart })).resolves.toEqual({
      kind: "skipped",
    });

    expect(onDispatchStart).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it.each([
    { name: "forum topic", threadId: 456, rejectFallback: false },
    { name: "General topic", threadId: 1, rejectFallback: false },
    { name: "failed fallback", threadId: undefined, rejectFallback: true },
  ])("returns the dispatch error after $name fallback", async ({ threadId, rejectFallback }) => {
    const sendMessage = rejectFallback
      ? vi.fn().mockRejectedValue(new Error("blocked by user"))
      : vi.fn().mockResolvedValue(undefined);
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
      threadId === 456 ? { message_thread_id: 456 } : undefined,
    );
  });

  it("finalizes adoption once before settlement and ignores later dispatch failure", async () => {
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
      await turnAdoptionLifecycle?.onAdopted();
      return { kind: "failed-retryable", error: new Error("late dispatch failure") };
    });
    await expectCompletedReplay(
      await replayMessage({ finalizeSpooledReplayResult }, (result) =>
        events.push(`participant:${result.kind}`),
      ),
    );
    expect(events).toEqual(["finalizer:adopted", "participant:completed"]);
  });

  it("owns the detached dispatch to completion after adoption", async () => {
    const dispatchGate = createDeferred<void>();
    const completed = vi.fn();
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      await turnAdoptionLifecycle.onAdopted();
      await dispatchGate.promise;
      return { kind: "completed" };
    });
    try {
      await expect(processIsolated()).resolves.toEqual({ kind: "completed" });
      const completion = expectDefined(detachedWork.tasks[0], "detached dispatch task").then(
        completed,
      );
      expect(completed).not.toHaveBeenCalled();
      dispatchGate.resolve();
      await completion;
      expect(completed).toHaveBeenCalledOnce();
    } finally {
      dispatchGate.resolve();
      await Promise.allSettled(detachedWork.tasks);
    }
  });

  it("settles a spooled participant retryably when detached admission is refused", async () => {
    const refusal = new Error("Gateway is restarting");
    detachedWork.run.mockRejectedValueOnce(refusal);
    await expect(processIsolated()).resolves.toEqual({
      kind: "failed-retryable",
      error: refusal,
    });
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("keeps a pre-adoption owner abort retryable when dispatch returns completed", async () => {
    const timeoutError = new Error("handler-timeout");
    const abortController = new AbortController();
    const finalizeSpooledReplayResult = passThroughFinalizer();
    dispatchTelegramMessage.mockImplementationOnce(async () => {
      abortController.abort(timeoutError);
      return { kind: "completed" };
    });

    await expect(
      processIsolated({
        finalizeSpooledReplayResult,
        spooledReplayAbortSignal: abortController.signal,
      }),
    ).resolves.toEqual({ kind: "failed-retryable", error: timeoutError });
    expect(finalizeSpooledReplayResult).toHaveBeenCalledWith(
      { kind: "failed-retryable", error: timeoutError },
      "terminal",
    );
  });

  it.each([false, true])(
    "retries irrevocable adoption until completion or owner cancellation (%s)",
    async (cancelled) => {
      const errors = [
        new Error("dedupe commit failed"),
        new Error("first retry failed"),
        new Error("second retry failed"),
      ];
      const abort = new AbortController();
      const cancellationError = new Error("outer spool timeout");
      const finalizeSpooledReplayResult = vi.fn(async () => {
        throw errors[0];
      });
      const completeSpooledReplayAfterIrrevocableAdoption = vi
        .fn<() => Promise<TelegramMessageProcessingResult>>()
        .mockRejectedValueOnce(errors[1])
        .mockRejectedValueOnce(errors[2])
        .mockResolvedValue({ kind: "completed" });
      dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
        await expect(turnAdoptionLifecycle.onAdopted()).rejects.toBe(errors[0]);
        return { kind: "completed" };
      });
      if (cancelled) {
        sleepWithAbort.mockImplementationOnce(async (_ms, signal) => {
          abort.abort(cancellationError);
          signal?.throwIfAborted();
        });
      }
      const turnContext = {
        finalizeSpooledReplayResult,
        completeSpooledReplayAfterIrrevocableAdoption,
        spooledReplayAbortSignal: abort.signal,
      };
      if (cancelled) {
        await expect(processIsolated(turnContext)).resolves.toEqual({
          kind: "failed-retryable",
          error: cancellationError,
        });
        expect(completeSpooledReplayAfterIrrevocableAdoption).toHaveBeenCalledOnce();
      } else {
        await expectCompletedReplay(await replayMessage(turnContext));
        expect(completeSpooledReplayAfterIrrevocableAdoption.mock.calls).toEqual(
          errors.map((error) => [error]),
        );
      }
    },
  );

  it("keeps isolated retry settlement separate from the outer spool participant", async () => {
    const retryError = new Error("retry this attempt");
    dispatchTelegramMessage.mockResolvedValueOnce({
      kind: "failed-retryable",
      error: retryError,
    });
    let outerSettles = 0;
    const replay = await replayMessage(undefined, () => outerSettles++, true);
    expect(replay.value).toEqual({ kind: "failed-retryable", error: retryError });
    expect(outerSettles).toBe(0);
    const outerParticipant = replay.deferredWork;
    expect(outerParticipant).toBeDefined();
    outerParticipant?.settle({ kind: "skipped" });
    await expect(outerParticipant?.task).resolves.toEqual({ kind: "skipped" });
  });

  it("aborts an isolated queued retry when its outer spool owner is cancelled", async () => {
    const outerAbortController = new AbortController();
    const deferred = createDeferred<void>();
    let queuedAbortSignal: AbortSignal | undefined;
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      const turnAbortSignal = turnAdoptionLifecycle?.abortSignal;
      queuedAbortSignal = turnAbortSignal;
      turnAdoptionLifecycle?.onDeferred?.();
      deferred.resolve();
      if (!turnAbortSignal?.aborted) {
        await new Promise<void>((resolve) => {
          turnAbortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      await turnAdoptionLifecycle?.onAbandoned?.();
      return { kind: "completed" };
    });

    const processing = processIsolated({ spooledReplayAbortSignal: outerAbortController.signal });
    await deferred.promise;
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
