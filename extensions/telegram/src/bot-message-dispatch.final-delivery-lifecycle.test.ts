import { expectDefined } from "@openclaw/normalization-core";
import { Bot } from "grammy";
import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { createStructuredOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import { dispatchReplyWithBufferedBlockDispatcher as dispatchThroughSharedOwner } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createReasoningStreamContext,
  createDirectSessionPayload,
  createStatusReactionController as createReactions,
  createTelegramDraftStream as createDraftStream,
  deliverInboundReplyWithMessageSendContext as deliverInbound,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher as dispatchReplyMock,
  dispatchWithContext,
  editMessageTelegram,
  emitToolStart,
  expectDeliveredReply,
  loadSessionStore,
  setupDraftStreams,
  type TelegramMessageContext,
  type DispatchReplyWithBufferedBlockDispatcherArgs as DispatchArgs,
} from "./bot-message-dispatch.test-harness.js";
import type * as DeliveryRepliesModule from "./bot/delivery.replies.js";
import type * as DraftStreamModule from "./draft-stream.js";
import type * as SendEditModule from "./send-edit.js";

const failedDelivery = "I couldn't deliver my reply. Please ask again.";
const privateChat = { id: 123, type: "private" as const, first_name: "Test" };
const telegramMessage = (message_id: number, text: string, chat = privateChat) => ({
  message_id,
  date: 0,
  chat,
  text,
});
const toolStart = (
  options: Parameters<typeof emitToolStart>[0],
  name: string,
  toolCallId: string,
) => emitToolStart(options, { name, toolCallId, phase: "start" });
function expectStatus(status: ReturnType<typeof createReactions>, error: number, done: number) {
  expect({
    error: status.setError.mock.calls.length,
    done: status.setDone.mock.calls.length,
  }).toEqual({ error, done });
}

function retiredPluginError() {
  return Object.assign(
    new Error("Plugin telegram was reloaded or disabled; use its current tools."),
    { name: "PluginInstanceUnavailableError" },
  );
}

function resolveReply(
  replyResolver: NonNullable<DispatchArgs["replyResolver"]>,
  before?: (params: DispatchArgs) => Promise<void>,
) {
  const resolver = vi.fn(replyResolver);
  dispatchReplyMock.mockImplementationOnce(async (params) => {
    await before?.(params);
    return dispatchThroughSharedOwner({ ...params, replyResolver: resolver });
  });
  return resolver;
}

async function installRealDelivery() {
  const [draft, delivery, edit] = await Promise.all([
    vi.importActual<typeof DraftStreamModule>("./draft-stream.js"),
    vi.importActual<typeof DeliveryRepliesModule>("./bot/delivery.replies.js"),
    vi.importActual<typeof SendEditModule>("./send-edit.js"),
  ]);
  createDraftStream.mockImplementation(draft.createTelegramDraftStream);
  deliverReplies.mockImplementation(delivery.deliverStructuredReplies);
  editMessageTelegram.mockImplementation(edit.editMessageTelegram);
  return { draft, delivery, edit };
}

async function observeTransport() {
  const { delivery } = await installRealDelivery();
  const bot = createBot();
  const messages = new Map<number, string>();
  let nextMessageId = 1000;
  const sendMessage = vi.spyOn(bot.api, "sendMessage").mockImplementation(async (chatId, text) => {
    const message_id = ++nextMessageId;
    messages.set(message_id, text);
    return telegramMessage(message_id, text, { ...privateChat, id: Number(chatId) });
  });
  const editMessageText = vi
    .spyOn(bot.api, "editMessageText")
    .mockImplementation(async (_chatId, messageId, text) => {
      if (typeof text !== "string") {
        throw new Error("This transport fixture expects legacy Telegram text.");
      }
      if (!messages.has(messageId)) {
        throw new Error("Bad Request: message to edit not found");
      }
      messages.set(messageId, text);
      return true;
    });
  const deleteMessage = vi
    .spyOn(bot.api, "deleteMessage")
    .mockImplementation(async (_chatId, messageId) => {
      messages.delete(messageId);
      return true;
    });
  return {
    bot,
    messages,
    sendMessage,
    editMessageText,
    deleteMessage,
    deliver: delivery.deliverStructuredReplies,
  };
}

let inboundSequence = 0;

function progressContext(statusReactionController = createReactions()) {
  const messageId = 456 + inboundSequence++;
  return createContext({
    ctxPayload: {
      ...createDirectSessionPayload(),
      Provider: "telegram",
      Surface: "telegram",
      MessageSid: String(messageId),
    },
    threadSpec: { id: undefined, scope: "none" },
    replyThreadId: undefined,
    msg: {
      chat: privateChat,
      message_id: messageId,
      date: 0,
    },
    statusReactionController,
  });
}

const progressConfig = {
  streaming: { mode: "progress", progress: { toolProgress: true } },
} as const;

function dispatchTurn(
  bot: Bot,
  options: Omit<Parameters<typeof dispatchWithContext>[0], "bot" | "context" | "telegramCfg"> & {
    status?: ReturnType<typeof createReactions>;
  } = {},
) {
  const { status, streamMode = "partial", ...rest } = options;
  return dispatchWithContext({
    bot,
    context: progressContext(status),
    streamMode,
    telegramCfg: streamMode === "progress" ? progressConfig : { streaming: { mode: streamMode } },
    ...rest,
  });
}

describeTelegramDispatch("dispatchTelegramMessage final-delivery-lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    { failure: "retired instance", mode: "progress" },
    { failure: "definite no-send", mode: "progress" },
    { failure: "rejected tail", mode: "off" },
    { failure: "network failure", mode: "off" },
    { failure: "opaque fetch failure", mode: "off" },
  ] as const)(
    "preserves accepted content and reports $failure with streaming $mode",
    async ({ failure, mode }) => {
      const { bot, messages, sendMessage, deleteMessage } = await observeTransport();
      const failedStatus = createReactions();
      const prefix = "Accepted final prefix";
      const tail = "Rejected final tail";
      const partial = failure === "rejected tail";
      const finalText = partial
        ? `${prefix}\n\n${tail}`
        : "The answer whose delivery cannot be confirmed";
      if (partial) {
        deliverInbound.mockImplementationOnce(async () => {
          const accepted = await bot.api.sendMessage(123, prefix);
          sendMessage.mockRejectedValueOnce(new Error("final tail rejected"));
          try {
            await bot.api.sendMessage(123, tail);
          } catch (error) {
            throw createChannelPartialDeliveryError(
              error,
              createAcceptedChannelDeliveryResult({
                results: [{ messageId: String(accepted.message_id) }],
                content: prefix,
              }),
            );
          }
          throw new Error("Expected the final tail send to reject");
        });
      } else if (failure === "retired instance") {
        deliverInbound.mockRejectedValueOnce(retiredPluginError());
      } else if (failure === "network failure" || failure === "opaque fetch failure") {
        const error = new Error("fetch failed");
        if (failure === "network failure") {
          error.cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
        }
        deliverInbound.mockRejectedValueOnce(error);
      } else {
        deliverInbound.mockResolvedValue({ status: "handled_no_send" });
      }
      const replyResolver = resolveReply(async (_ctx, options) => {
        if (mode === "progress") {
          await toolStart(options, "exec", "failed-1");
          expect([...messages.values()]).toEqual([expect.stringContaining("Exec")]);
        }
        return { text: finalText };
      });
      const result = await dispatchTurn(bot, {
        status: failedStatus,
        streamMode: mode,
        retryDispatchErrors: true,
        suppressFailureFallback: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(replyResolver).toHaveBeenCalledOnce();
      await expect(replyResolver.mock.results[0]?.value).resolves.toEqual({ text: finalText });

      expect([...messages.values()]).toEqual([
        ...(partial ? [prefix] : []),
        mode === "progress"
          ? expect.stringMatching(/Exec|I couldn't deliver my reply/i)
          : failure === "network failure"
            ? "I couldn't deliver my reply because of a network problem. Please ask again."
            : failedDelivery,
      ]);
      expect(sendMessage.mock.calls.some(([, text]) => text === finalText)).toBe(false);
      expectStatus(failedStatus, 1, 0);
      if (failure !== "definite no-send") {
        expect(deliverInbound).toHaveBeenCalledOnce();
        expect(result).toEqual({ kind: "completed" });
      }
      if (mode === "progress") {
        expect(deliverReplies).not.toHaveBeenCalled();
        expect(deleteMessage).not.toHaveBeenCalled();
      }
      if (partial) {
        expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
          prefix,
          tail,
          failedDelivery,
        ]);
        return;
      }

      const retainedFailure = [...messages.entries()];
      const nextStatus = createReactions();
      deliverInbound.mockResolvedValue({
        status: "unsupported",
        reason: "missing_outbound_handler",
      });
      const nextText = "The next turn succeeds";
      resolveReply(async (_ctx, options) => {
        await toolStart(options, "read", "next-1");
        return { text: nextText };
      });
      await dispatchTurn(bot, {
        status: nextStatus,
        streamMode: mode,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect([...messages.entries()]).toEqual([...retainedFailure, [expect.any(Number), nextText]]);
      expect(sendMessage.mock.calls.filter(([, text]) => text === nextText)).toHaveLength(1);
      expectStatus(nextStatus, 0, 1);
      expect(failedStatus.setDone).not.toHaveBeenCalled();
    },
  );

  it.each(["replacement", "second"] as const)(
    "preserves the accepted answer across a %s failure",
    async (failure) => {
      const { bot, messages, sendMessage, editMessageText } = await observeTransport();
      const status = createReactions();
      const first = "First accepted answer";
      const preview = "Answer in progress while checking the completed result";
      const final = "Complete answer already accepted by Telegram";
      resolveReply(
        async (_ctx, options) => {
          if (failure === "replacement") {
            sendMessage.mockRejectedValueOnce(new Error("replacement preview rejected"));
            await toolStart(options, "read", "read-1");
          }
          return { text: final };
        },
        async (params) => {
          if (failure === "second") {
            await params.dispatcherOptions.deliver({ text: first }, { kind: "final" });
          }
          await params.replyOptions?.onAssistantMessageStart?.();
          await params.replyOptions?.onPartialReply?.({ text: preview });
          await createDraftStream.mock.results[0]?.value?.flush();
          expect([...messages.values()]).toEqual(
            failure === "second" ? [first, preview] : [preview],
          );
          if (failure === "second") {
            editMessageText.mockRejectedValueOnce(new Error("second final edit rejected"));
            sendMessage.mockRejectedValueOnce(new Error("second final send rejected"));
          }
        },
      );
      const result = await dispatchTurn(bot, {
        status,
        cfg:
          failure === "replacement"
            ? undefined
            : { channels: { telegram: { botToken: "synthetic-test-token" } } },
        retryDispatchErrors: failure === "replacement" ? undefined : true,
        suppressFailureFallback: failure === "replacement" ? undefined : true,
      });
      await vi.advanceTimersByTimeAsync(failure === "replacement" ? 10_000 : 5_000);
      if (failure === "second") {
        const visible = [...messages.entries()];
        expect(visible[0]?.[1]).toBe(first);
        expect(sendMessage.mock.calls.filter(([, text]) => text === first)).toHaveLength(1);
        expect(visible.some(([, text]) => text === final)).toBe(false);
        expect(visible.some(([, text]) => text === failedDelivery)).toBe(true);
        expect(sendMessage.mock.calls.filter(([, text]) => text === final)).toHaveLength(1);
        expectStatus(status, 1, 0);
      } else {
        expect(result).toEqual({ kind: "completed" });
        expect([...messages.values()]).toEqual([final]);
        expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
          preview,
          expect.stringContaining("Read"),
          final,
        ]);
      }
    },
  );

  it("does not retry or erase an accepted final after late cancellation", async () => {
    const { bot, messages, sendMessage, deliver } = await observeTransport();
    const status = createReactions();
    const final = "Accepted final survives cleanup";
    const abortController = new AbortController();
    deliverReplies.mockImplementationOnce(async (params) => {
      const result = await deliver(params);
      abortController.abort(new Error("turn cancelled after final acceptance"));
      return result;
    });
    resolveReply(async (_ctx, options) => {
      await toolStart(options, "exec", "cleanup-1");
      return { text: final };
    });

    await dispatchTurn(bot, {
      status,
      streamMode: "progress",
      retryDispatchErrors: true,
      turnAdoptionLifecycle: {
        abortSignal: abortController.signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect([...messages.values()].filter((text) => text === final)).toEqual([final]);
    expect(sendMessage.mock.calls.filter(([, text]) => text === final)).toHaveLength(1);
    expect(deliverReplies).toHaveBeenCalledOnce();
    expect(status.setError).not.toHaveBeenCalled();
  });
});

function mockTurn(run: (params: DispatchArgs) => Promise<void>) {
  dispatchReplyMock.mockImplementation(async (params) => {
    await run(params);
    return { queuedFinal: true };
  });
}

function createReasoningFinalDelivery(): (params: DispatchArgs) => Promise<void> {
  const payload = { text: "hidden", isReasoning: true };
  const plan = expectDefined(
    createStructuredOutboundPayloadPlan([payload])[0],
    "prepared reasoning payload",
  );
  return async ({ dispatcherOptions }) => {
    const deliverPrepared = expectDefined(
      dispatcherOptions.deliverPrepared,
      "prepared Telegram delivery",
    );
    await deliverPrepared(plan, { kind: "final" });
  };
}

describeTelegramDispatch("dispatchTelegramMessage reasoning lanes", () => {
  it("routes prepared typed reasoning-only finals to the reasoning lane when reasoning streams", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    mockTurn(createReasoningFinalDelivery());
    await dispatchWithContext({ context: createReasoningStreamContext() });
    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "🧠 _hidden_",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(answerDraftStream.update).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("suppresses whitespace-form internal prefixes until one visible final", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "< / internal", isReasoning: true },
        { kind: "block" },
      );
      expect(reasoningDraftStream.update).not.toHaveBeenCalled();
      expect(deliverReplies).not.toHaveBeenCalled();
      await dispatcherOptions.deliver({ text: "VISIBLE" }, { kind: "final" });
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "VISIBLE",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("routes prepared typed reasoning-only finals to durable delivery when reasoning is persistent", async () => {
    const sessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({
      [sessionKey]: { reasoningLevel: "on" },
    });
    mockTurn(createReasoningFinalDelivery());
    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: sessionKey } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });
    expectDeliveredReply(0, { text: "🧠 _hidden_" });
    expect(deliverReplies).toHaveBeenCalledTimes(1);
  });

  it("does not persist typed reasoning-only finals in progress stream mode", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(answerDraftStream.update).not.toHaveBeenCalled();
  });
});
