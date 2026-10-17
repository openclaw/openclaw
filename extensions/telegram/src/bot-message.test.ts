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
  let processMessage: ReturnType<typeof createTelegramMessageProcessor>;
  beforeEach(() => {
    buildTelegramMessageContext.mockClear().mockResolvedValue(createMessageContext());
    dispatchTelegramMessage.mockClear();
    verboseLog.mockClear();
    sleepWithAbort.mockReset().mockResolvedValue(undefined);
    upsertChannelPairingRequest.mockClear();
    processMessage = createTelegramMessageProcessor(baseDeps);
  });

  const baseTurnContext = {
    cfg: {},
    telegramCfg: {},
  } satisfies TelegramMessageProcessorTurnContext;

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
    processor: ReturnType<typeof createTelegramMessageProcessor>,
    turnContext?: Partial<TelegramMessageProcessorTurnContext>,
    primaryCtxOverrides: Record<string, unknown> = {},
    options: Parameters<typeof processor>[0]["options"] = {},
    allMedia: Parameters<typeof processor>[0]["allMedia"] = [],
  ) {
    return await processor({
      ctx: {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
        },
        ...primaryCtxOverrides,
      } as unknown as Parameters<typeof processor>[0]["ctx"],
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
    sendMessage: ReturnType<typeof vi.fn>,
    context: Record<string, unknown> = {},
  ) {
    const runtimeError = vi.fn();
    const dispatchError = new Error("dispatch exploded");
    buildTelegramMessageContext.mockResolvedValue(createMessageContext(context));
    dispatchTelegramMessage.mockRejectedValue(dispatchError);
    const processor = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    return { processMessage: processor, runtimeError, dispatchError };
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

  function finalizer() {
    return vi.fn(async (result: TelegramMessageProcessingResult) => result);
  }

  function observeParticipant(onSettle: (result: TelegramMessageProcessingResult) => void) {
    const participant = expectDefined(
      createTelegramSpooledReplayDeferredParticipant("test:settlement"),
      "spooled replay participant",
    );
    const settle = participant.settle;
    participant.settle = (result) => {
      onSettle(result);
      settle(result);
    };
  }

  async function expectCompletedReplay(
    replay: Awaited<ReturnType<typeof runWithTelegramSpooledReplayUpdate>>,
  ) {
    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
  }

  async function replaySample(
    turnContext: Partial<TelegramMessageProcessorTurnContext> = {},
    beforeProcess: () => void = () => {},
    options: Parameters<typeof processMessage>[0]["options"] = {},
  ) {
    const update = { update_id: 123458 };
    return runWithTelegramSpooledReplayUpdate(update, () => {
      beforeProcess();
      return processSampleMessage(processMessage, turnContext, { update }, options);
    });
  }

  function rejectAdoption(error: Error) {
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      await expect(turnAdoptionLifecycle?.onAdopted()).rejects.toBe(error);
      return { kind: "completed" };
    });
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

    processMessage = createTelegramMessageProcessor({
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

  it("runs the dispatch-start lifecycle after context creation and before dispatch", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(createMessageContext({ sendTyping }));

    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toEqual({
      kind: "completed",
    });

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(onDispatchStart).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(requireInvocationOrder(sendTyping.mock, "send typing invocation")).toBeLessThan(
      requireInvocationOrder(onDispatchStart.mock, "dispatch-start invocation"),
    );
    expect(requireInvocationOrder(onDispatchStart.mock, "dispatch-start invocation")).toBeLessThan(
      requireInvocationOrder(dispatchTelegramMessage.mock, "message dispatch invocation"),
    );
  });

  it("does not run the dispatch-start lifecycle when no context is produced", async () => {
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(null);

    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toEqual({
      kind: "skipped",
    });

    expect(onDispatchStart).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

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

  it("keeps dispatch running when the early typing cue fails", async () => {
    const sendTyping = vi.fn().mockRejectedValue(new Error("typing failed"));
    buildTelegramMessageContext.mockResolvedValue(createMessageContext({ sendTyping }));

    await expect(processSampleMessage(processMessage)).resolves.toEqual({ kind: "completed" });

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "forum topic", threadId: 456, fallbackFails: false },
    { name: "General topic", threadId: 1, fallbackFails: false },
    { name: "failed fallback delivery", threadId: undefined, fallbackFails: true },
  ])("keeps dispatch errors retryable with $name fallback", async ({ threadId, fallbackFails }) => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    if (fallbackFails) {
      sendMessage.mockRejectedValue(new Error("blocked by user"));
    }
    const {
      processMessage: failingProcessor,
      runtimeError,
      dispatchError,
    } = createDispatchFailureHarness(
      sendMessage,
      threadId === undefined ? {} : { threadSpec: { id: threadId, scope: "forum" } },
    );
    const result = await processSampleMessage(failingProcessor);

    expect(result).toEqual({ kind: "failed-retryable", error: dispatchError });

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      threadId === 456 ? { message_thread_id: 456 } : undefined,
    );
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });

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
    const replay = await replaySample({ finalizeSpooledReplayResult }, () => {
      observeParticipant((result) => events.push(`participant:${result.kind}`));
    });

    await expectCompletedReplay(replay);
    expect(events).toEqual(["finalizer:adopted", "participant:completed"]);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(1);
  });

  it("keeps a spooled replay completed when dispatch fails after adoption", async () => {
    const lateError = new Error("late dispatch failure");
    const finalizeSpooledReplayResult = finalizer();
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      await turnAdoptionLifecycle?.onAdopted();
      return { kind: "failed-retryable", error: lateError };
    });
    const replay = await replaySample({ finalizeSpooledReplayResult });

    await expectCompletedReplay(replay);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(1);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledWith({ kind: "completed" }, "adopted");
  });

  it("keeps a pre-adoption owner abort retryable when dispatch returns completed", async () => {
    const timeoutError = new Error("handler-timeout");
    const abortController = new AbortController();
    const finalizeSpooledReplayResult = finalizer();
    dispatchTelegramMessage.mockImplementationOnce(async () => {
      abortController.abort(timeoutError);
      return { kind: "completed" };
    });

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
    rejectAdoption(finalizerError);
    const replay = await replaySample({
      finalizeSpooledReplayResult,
      completeSpooledReplayAfterIrrevocableAdoption,
    });

    await expectCompletedReplay(replay);
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
    rejectAdoption(finalizerError);
    sleepWithAbort.mockImplementationOnce(async (_delayMs, signal) => {
      outerAbortController.abort(cancellationError);
      if (signal?.aborted) {
        throw signal.reason;
      }
    });

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
    const finalizerError = new Error("dedupe commit failed");
    const finalizeSpooledReplayResult = finalizer().mockRejectedValueOnce(finalizerError);
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
    const replay = await replaySample({ finalizeSpooledReplayResult }, () => {
      observeParticipant(() => {
        participantSettles += 1;
      });
    });

    expect(admissionErrors[0]).toBe(finalizerError);
    expect(admissionErrors.slice(1)).toEqual([undefined, undefined]);
    expect(settledAfterFirstAdmission).toBe(false);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(2);
    expect(participantSettles).toBe(1);
    await expectCompletedReplay(replay);
  });

  it("keeps isolated retry settlement separate from the outer spool participant", async () => {
    const retryError = new Error("retry this attempt");
    dispatchTelegramMessage.mockResolvedValueOnce({
      kind: "failed-retryable",
      error: retryError,
    });
    let outerSettles = 0;

    const replay = await replaySample(
      {},
      () => {
        observeParticipant(() => {
          outerSettles += 1;
        });
      },
      { spooledReplay: true, isolateSpooledReplaySettlement: true },
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
      turnAdoptionLifecycle?.onAbandoned?.();
      return { kind: "completed" };
    });

    const processing = processSampleMessage(
      processMessage,
      { spooledReplayAbortSignal: outerAbortController.signal },
      {},
      { spooledReplay: true, isolateSpooledReplaySettlement: true },
    );
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
    const { processMessage: failingProcessor, dispatchError } =
      createDispatchFailureHarness(sendMessage);

    const frame = await runWithTelegramUpdateProcessingFrame(async () =>
      processSampleMessage(failingProcessor, undefined, {}, { spooledReplay: true }),
    );

    expect(frame.value).toEqual({ kind: "failed-retryable", error: dispatchError });
    expect(frame.result).toBeUndefined();
  });
});
