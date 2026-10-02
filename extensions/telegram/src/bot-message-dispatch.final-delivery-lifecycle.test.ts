import { Bot } from "grammy";
import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { dispatchReplyWithBufferedBlockDispatcher as dispatchThroughSharedOwner } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
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
  telegramDepsForTest,
  type DispatchReplyWithBufferedBlockDispatcherArgs as DispatchArgs,
  editMessageReplyMarkupTelegram,
  emitTelegramMessageSentHooks,
} from "./bot-message-dispatch.test-harness.js";
import type * as DeliveryRepliesModule from "./bot/delivery.replies.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import type * as DraftStreamModule from "./draft-stream.js";
import type { TelegramDraftStream } from "./draft-stream.js";
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

  it.each(["recording", "replacement", "second"] as const)(
    "preserves the accepted answer across a %s failure",
    async (failure) => {
      const { bot, messages, sendMessage, editMessageText } = await observeTransport();
      const status = createReactions();
      const first = "First accepted answer";
      const preview = "Answer in progress while checking the completed result";
      const final = "Complete answer already accepted by Telegram";
      const recordContext = vi.fn(async () => {
        throw new Error("prompt context recording failed");
      });
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
        moduleMocks:
          failure === "recording"
            ? {
                ...telegramDepsForTest,
                recordOutboundMessageForPromptContext: recordContext,
              }
            : undefined,
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
        if (failure === "recording") {
          expect(sendMessage).toHaveBeenCalledOnce();
          expect(recordContext).toHaveBeenCalledWith(
            expect.objectContaining({ text: final, messageId: [...messages.keys()][0] }),
          );
        } else {
          expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
            preview,
            expect.stringContaining("Read"),
            final,
          ]);
        }
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

const question = {
  text: "Should this harmless check continue?",
  channelData: { askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" } },
};
const buttons = [[{ text: "Continue", callback_data: "ask:continue" }]];
const settled = "The question has settled.";

describeTelegramDispatch("dispatchTelegramMessage native questions", () => {
  it("delivers a question once while an in-flight progress draft is retired", async () => {
    vi.useFakeTimers();
    const editStarted = createDeferred<void>();
    const releaseEdit = createDeferred<void>();
    let questionDelivery: unknown;
    const register = vi
      .spyOn(questionGatewayRuntime, "registerChannelDelivery")
      .mockImplementation(() => {});
    try {
      const { bot, messages, sendMessage, editMessageText, deleteMessage } =
        await observeTransport();
      dispatchReplyMock.mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: "Check the workspace before asking the user", status: "in_progress" }],
        });
        const draftResult = createDraftStream.mock.results[0];
        if (draftResult?.type !== "return") {
          throw new Error("Expected the Telegram draft factory to return a stream");
        }
        const draft: TelegramDraftStream = draftResult.value;
        await draft.flush();
        expect(sendMessage).toHaveBeenCalledOnce();

        const edit = editMessageText.getMockImplementation()!;
        editMessageText.mockImplementationOnce(async (...args) => {
          editStarted.resolve();
          await releaseEdit.promise;
          return edit(...args);
        });
        await replyOptions?.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: "Verify the workspace before asking the user", status: "in_progress" }],
        });
        const flushing = draft.flush();
        await editStarted.promise;
        const retirement = replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
        const delivery = dispatcherOptions.deliver(
          { ...question, channelData: { ...question.channelData, telegram: { buttons } } },
          { kind: "tool" },
        );
        releaseEdit.resolve();
        await Promise.all([flushing, retirement]);
        questionDelivery = await delivery;
        return { queuedFinal: true };
      });

      await dispatchTurn(bot, {
        streamMode: "progress",
        cfg: { channels: { telegram: { botToken: "123456:question-fixture" } } },
      });
      await vi.runOnlyPendingTimersAsync();
      expect(questionDelivery).toMatchObject({ visibleReplySent: true });
      expect(sendMessage.mock.calls.filter(([, text]) => text === question.text)).toHaveLength(1);
      expect([...messages.values()]).toEqual([question.text]);
      const [messageId] = messages.keys();
      expect(editMessageText).toHaveBeenCalledWith(
        "123",
        messageId,
        question.text,
        expect.objectContaining({ reply_markup: { inline_keyboard: buttons } }),
      );
      expect(register).toHaveBeenCalledOnce();
      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({
          questionId: question.channelData.askUser.questionId,
          deliveryId: `telegram:default:123:${messageId}`,
        }),
      );
      expect(deleteMessage).toHaveBeenCalledWith(123, 1001);
      expect(deleteMessage).not.toHaveBeenCalledWith(123, messageId);
    } finally {
      releaseEdit.resolve();
      register.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    { streamMode: "progress", controls: "buttonless", rejectControls: false },
    { streamMode: "partial", controls: "buttons", rejectControls: true },
  ] as const)(
    "keeps the accepted $controls question on the $streamMode stream (controls rejected: $rejectControls)",
    async ({ streamMode, controls, rejectControls }) => {
      vi.useFakeTimers();
      let draft: TelegramDraftStream | undefined;
      const register = vi
        .spyOn(questionGatewayRuntime, "registerChannelDelivery")
        .mockImplementation(() => {});
      const status = createReactions();
      try {
        const { draft: realDraft, delivery, edit } = await installRealDelivery();
        createDraftStream.mockImplementation((params) => {
          const stream = realDraft.createTelegramDraftStream(params);
          draft ??= stream;
          return stream;
        });
        deliverReplies.mockImplementation(delivery.deliverReplies);
        editMessageReplyMarkupTelegram.mockImplementation(edit.editMessageReplyMarkupTelegram);
        const visible = new Map<number, string>();
        const keyboards = new Map<number, unknown>();
        let nextMessageId = 1001;
        let rejectedControlEdits = 0;
        const ok = (result: unknown = true) => Response.json({ ok: true, result });
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const method = new URL(input instanceof Request ? input.url : String(input)).pathname
            .split("/")
            .at(-1);
          if (typeof init?.body !== "string") {
            throw new Error("Expected a JSON Telegram request");
          }
          const payload = asNonArrayRecord(JSON.parse(init.body));
          const messageId =
            typeof payload.message_id === "number" ? payload.message_id : nextMessageId++;
          if (method === "deleteMessage") {
            visible.delete(messageId);
            keyboards.delete(messageId);
            return ok();
          }
          if (method === "editMessageText" && payload.reply_markup && rejectControls) {
            rejectedControlEdits += 1;
            return Response.json({
              ok: false,
              error_code: 400,
              description: "Bad Request: BUTTON_DATA_INVALID",
            });
          }
          if (method === "editMessageReplyMarkup") {
            keyboards.set(messageId, payload.reply_markup);
            return ok();
          }
          if (method !== "sendMessage" && method !== "editMessageText") {
            throw new Error(`Unexpected Telegram method: ${method}`);
          }
          if (typeof payload.text !== "string") {
            throw new Error("Expected Telegram message text");
          }
          visible.set(messageId, payload.text);
          if (payload.reply_markup !== undefined) {
            keyboards.set(messageId, payload.reply_markup);
          }
          return ok(telegramMessage(messageId, payload.text));
        };
        const bot = new Bot("123456:question-fixture", {
          client: { fetch: asTelegramClientFetch(fetch) },
        });

        let questionMessageId: number | undefined;
        dispatchReplyMock.mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          await toolStart(replyOptions, "exec", "check");
          await vi.advanceTimersByTimeAsync(1500);
          await draft?.flush();
          expect([...visible.values()].some((text) => text.includes("Exec"))).toBe(true);
          await dispatcherOptions.deliver(
            {
              ...question,
              channelData: {
                ...question.channelData,
                ...(controls === "buttons" ? { telegram: { buttons } } : {}),
              },
            },
            { kind: "tool" },
          );
          questionMessageId = draft?.messageId();
          expect(visible.get(questionMessageId ?? -1)).toBe(question.text);
          await toolStart(replyOptions, "wait", "wait");
          await vi.advanceTimersByTimeAsync(1500);
          await draft?.flush();
          expect(visible.get(questionMessageId ?? -1)).toBe(question.text);
          if (controls === "buttons") {
            expect(keyboards.get(questionMessageId ?? -1)).toEqual({
              inline_keyboard: [[{ text: "Continue", callback_data: "ask:continue" }]],
            });
          }
          await dispatcherOptions.deliver({ text: settled }, { kind: "final" });
          return { queuedFinal: true };
        });
        await dispatchWithContext({
          bot,
          cfg: { channels: { telegram: { botToken: "123456:question-fixture" } } },
          context: createContext({
            ctxPayload: createDirectSessionPayload(),
            threadSpec: { id: undefined, scope: "none" },
            replyThreadId: undefined,
            statusReactionController: status,
          }),
          streamMode,
          telegramCfg: { streaming: { mode: streamMode, progress: { toolProgress: true } } },
        });
        await vi.runOnlyPendingTimersAsync();
        if (rejectControls) {
          expect(rejectedControlEdits).toBe(1);
          expect(register).not.toHaveBeenCalled();
          expect([...visible.values()]).toEqual([question.text]);
          expect([...keyboards.values()]).toEqual([]);
          expect(status.setError).toHaveBeenCalledOnce();
          expect(emitTelegramMessageSentHooks).toHaveBeenCalledWith(
            expect.objectContaining({ success: false, messageId: [...visible.keys()][0] }),
          );
        } else {
          expect([...visible.values()]).toEqual([question.text, settled]);
          expect(register).toHaveBeenCalledOnce();
          const registration = register.mock.calls[0]?.[0];
          expect(registration).toMatchObject({
            questionId: question.channelData.askUser.questionId,
            deliveryId: `telegram:default:123:${questionMessageId}`,
          });
          await registration?.finalize("Answered: continue");
          expect(visible.get(questionMessageId ?? -1)).toContain("Answered: continue");
          expect(keyboards.get(questionMessageId ?? -1)).toEqual({ inline_keyboard: [] });
          expect([...visible.values()]).toContain(settled);
        }
      } finally {
        await draft?.discard();
        register.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
