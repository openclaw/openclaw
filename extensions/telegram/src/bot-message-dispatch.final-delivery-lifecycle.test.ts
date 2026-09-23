import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { dispatchReplyWithBufferedBlockDispatcher as dispatchThroughSharedOwner } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createDirectSessionPayload,
  createStatusReactionController,
  createTelegramDraftStream,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  emitToolStart,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";
import type { DispatchReplyWithBufferedBlockDispatcherArgs } from "./bot-message-dispatch.test-harness.js";
import type * as DeliveryRepliesModule from "./bot/delivery.replies.js";
import type * as DraftStreamModule from "./draft-stream.js";
import type * as SendEditModule from "./send-edit.js";

function retiredPluginError() {
  return Object.assign(
    new Error("Plugin telegram was reloaded or disabled; use its current tools."),
    { name: "PluginInstanceUnavailableError" },
  );
}

async function setupObservedProgressTransport() {
  const [draft, delivery, edit] = await Promise.all([
    vi.importActual<typeof DraftStreamModule>("./draft-stream.js"),
    vi.importActual<typeof DeliveryRepliesModule>("./bot/delivery.replies.js"),
    vi.importActual<typeof SendEditModule>("./send-edit.js"),
  ]);
  createTelegramDraftStream.mockImplementation(draft.createTelegramDraftStream);
  deliverReplies.mockImplementation(delivery.deliverStructuredReplies);
  editMessageTelegram.mockImplementation(edit.editMessageTelegram);
  const bot = createBot();
  const messages = new Map<number, string>();
  let nextMessageId = 1000;
  const sendMessage = vi.spyOn(bot.api, "sendMessage").mockImplementation(async (chatId, text) => {
    const message_id = ++nextMessageId;
    messages.set(message_id, text);
    return {
      message_id,
      date: 0,
      chat: { id: Number(chatId), type: "private", first_name: "Test" },
      text,
    };
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

function progressContext(
  statusReactionController = createStatusReactionController(),
  messageId = 456,
) {
  return createContext({
    ctxPayload: { ...createDirectSessionPayload(), MessageSid: String(messageId) },
    threadSpec: { id: undefined, scope: "none" },
    replyThreadId: undefined,
    msg: {
      chat: { id: 123, type: "private", first_name: "Test" },
      message_id: messageId,
      date: 0,
    },
    statusReactionController,
  });
}

const progressConfig = {
  streaming: { mode: "progress", progress: { toolProgress: true } },
} as const;

describeTelegramDispatch("dispatchTelegramMessage final-delivery-lifecycle", () => {
  it.each([
    {
      failure: "retired plugin instance",
      error: retiredPluginError(),
    },
    { failure: "definite no-send", error: undefined },
  ])(
    "retains progress without claiming final delivery after $failure and permits the next turn",
    async ({ error }) => {
      vi.useFakeTimers();
      try {
        const { bot, messages, sendMessage, deleteMessage } =
          await setupObservedProgressTransport();
        const failedStatus = createStatusReactionController();
        const finalText = "The completed answer that never reached Telegram";
        if (error) {
          deliverInboundReplyWithMessageSendContext.mockRejectedValueOnce(error);
        } else {
          // A confirmed non-send may be retried by the delivery owner, without rerunning the model.
          deliverInboundReplyWithMessageSendContext.mockResolvedValue({
            status: "handled_no_send",
          });
        }
        const replyResolver = vi.fn<
          NonNullable<DispatchReplyWithBufferedBlockDispatcherArgs["replyResolver"]>
        >(async (_ctx, options) => {
          await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "failed-1" });
          expect([...messages.values()]).toEqual([expect.stringContaining("Exec")]);
          return { text: finalText };
        });
        dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
          dispatchThroughSharedOwner({ ...params, replyResolver }),
        );

        const result = await dispatchWithContext({
          bot,
          context: progressContext(failedStatus),
          streamMode: "progress",
          telegramCfg: progressConfig,
          retryDispatchErrors: true,
          suppressFailureFallback: true,
        });
        await vi.advanceTimersByTimeAsync(5_000);

        expect([...messages.values()]).toEqual([expect.stringMatching(/Exec|chat history/i)]);
        expect(sendMessage.mock.calls.some(([, text]) => text === finalText)).toBe(false);
        expect(replyResolver).toHaveBeenCalledOnce();
        expect(deliverReplies).not.toHaveBeenCalled();
        expect(deleteMessage).not.toHaveBeenCalled();
        expect(failedStatus.setError).toHaveBeenCalledOnce();
        expect(failedStatus.setDone).not.toHaveBeenCalled();
        if (error) {
          expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledOnce();
          expect(result).toEqual({ kind: "completed" });
        }

        const retainedFailure = [...messages.entries()];
        const nextStatus = createStatusReactionController();
        deliverInboundReplyWithMessageSendContext.mockResolvedValue({
          status: "unsupported",
          reason: "missing_outbound_handler",
        });
        dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
          dispatchThroughSharedOwner({
            ...params,
            replyResolver: async (_ctx, options) => {
              await emitToolStart(options, { name: "read", phase: "start", toolCallId: "next-1" });
              return { text: "The next turn succeeds" };
            },
          }),
        );
        await dispatchWithContext({
          bot,
          context: progressContext(nextStatus, 457),
          streamMode: "progress",
          telegramCfg: progressConfig,
        });
        await vi.advanceTimersByTimeAsync(5_000);

        expect([...messages.entries()]).toEqual([
          ...retainedFailure,
          [expect.any(Number), "The next turn succeeds"],
        ]);
        expect(
          sendMessage.mock.calls.filter(([, text]) => text === "The next turn succeeds"),
        ).toHaveLength(1);
        expect(nextStatus.setDone).toHaveBeenCalledOnce();
        expect(nextStatus.setError).not.toHaveBeenCalled();
        expect(failedStatus.setDone).not.toHaveBeenCalled();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("sends one delivery-only notice without a preview when a retired instance rejects the final", async () => {
    vi.useFakeTimers();
    try {
      const { bot, messages, sendMessage } = await setupObservedProgressTransport();
      const failedStatus = createStatusReactionController();
      const finalText = "The answer whose delivery cannot be confirmed";
      deliverInboundReplyWithMessageSendContext.mockRejectedValueOnce(retiredPluginError());
      const replyResolver = vi.fn<
        NonNullable<DispatchReplyWithBufferedBlockDispatcherArgs["replyResolver"]>
      >(async () => ({ text: finalText }));
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
        dispatchThroughSharedOwner({ ...params, replyResolver }),
      );

      const result = await dispatchWithContext({
        bot,
        context: progressContext(failedStatus),
        streamMode: "off",
        telegramCfg: { streaming: { mode: "off" } },
        retryDispatchErrors: true,
        suppressFailureFallback: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(result).toEqual({ kind: "completed" });
      expect([...messages.values()]).toEqual([expect.stringMatching(/chat history/i)]);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls.some(([, text]) => text === finalText)).toBe(false);
      expect(replyResolver).toHaveBeenCalledOnce();
      expect(failedStatus.setError).toHaveBeenCalledOnce();
      expect(failedStatus.setDone).not.toHaveBeenCalled();

      const retainedNotice = [...messages.entries()];
      const nextStatus = createStatusReactionController();
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
        dispatchThroughSharedOwner({
          ...params,
          replyResolver: async () => ({ text: "The next unstreamed turn succeeds" }),
        }),
      );
      await dispatchWithContext({
        bot,
        context: progressContext(nextStatus, 457),
        streamMode: "off",
        telegramCfg: { streaming: { mode: "off" } },
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect([...messages.entries()]).toEqual([
        ...retainedNotice,
        [expect.any(Number), "The next unstreamed turn succeeds"],
      ]);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(replyResolver).toHaveBeenCalledOnce();
      expect(nextStatus.setDone).toHaveBeenCalledOnce();
      expect(nextStatus.setError).not.toHaveBeenCalled();
      expect(failedStatus.setDone).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("preserves an accepted final prefix and reports the rejected tail without replaying the answer", async () => {
    vi.useFakeTimers();
    try {
      const { bot, messages, sendMessage } = await setupObservedProgressTransport();
      const status = createStatusReactionController();
      const prefix = "Accepted final prefix";
      const tail = "Rejected final tail";
      const finalText = `${prefix}\n\n${tail}`;
      const tailError = new Error("final tail rejected");
      deliverInboundReplyWithMessageSendContext.mockImplementationOnce(async () => {
        const accepted = await bot.api.sendMessage(123, prefix);
        sendMessage.mockRejectedValueOnce(tailError);
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
      const replyResolver = vi.fn<
        NonNullable<DispatchReplyWithBufferedBlockDispatcherArgs["replyResolver"]>
      >(async () => ({ text: finalText }));
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
        dispatchThroughSharedOwner({ ...params, replyResolver }),
      );

      const result = await dispatchWithContext({
        bot,
        context: progressContext(status),
        streamMode: "off",
        telegramCfg: { streaming: { mode: "off" } },
        retryDispatchErrors: true,
        suppressFailureFallback: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(result).toEqual({ kind: "completed" });
      expect([...messages.values()]).toEqual([prefix, expect.stringMatching(/chat history/i)]);
      expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
        prefix,
        tail,
        expect.stringMatching(/chat history/i),
      ]);
      expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledOnce();
      expect(replyResolver).toHaveBeenCalledOnce();
      expect(status.setError).toHaveBeenCalledOnce();
      expect(status.setDone).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps a confirmed streamed answer when prompt-context recording fails", async () => {
    vi.useFakeTimers();
    try {
      const { bot, messages, sendMessage } = await setupObservedProgressTransport();
      const status = createStatusReactionController();
      const preview = "Answer in progress while checking the completed result";
      const final = "Complete answer already accepted by Telegram";
      const contextFailure = new Error("prompt context recording failed");
      const recordContext = vi.fn(async () => {
        throw contextFailure;
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: preview });
        await createTelegramDraftStream.mock.results[0]?.value?.flush();
        expect([...messages.values()]).toEqual([preview]);
        return dispatchThroughSharedOwner({
          ...params,
          replyResolver: async () => ({ text: final }),
        });
      });

      const result = await dispatchWithContext({
        bot,
        cfg: { channels: { telegram: { botToken: "synthetic-test-token" } } },
        context: progressContext(status),
        streamMode: "partial",
        telegramCfg: { streaming: { mode: "partial" } },
        telegramDeps: {
          ...telegramDepsForTest,
          recordOutboundMessageForPromptContext: recordContext,
        },
        retryDispatchErrors: true,
        suppressFailureFallback: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(result).toEqual({ kind: "completed" });
      expect([...messages.values()]).toEqual([final]);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(recordContext).toHaveBeenCalledWith(
        expect.objectContaining({ text: final, messageId: [...messages.keys()][0] }),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["progress deletion failure", "late cancellation"] as const)(
    "does not retry or erase an accepted final after %s",
    async (interruption) => {
      vi.useFakeTimers();
      try {
        const { bot, messages, sendMessage, deleteMessage, deliver } =
          await setupObservedProgressTransport();
        const status = createStatusReactionController();
        const abortController = new AbortController();
        if (interruption === "progress deletion failure") {
          deleteMessage.mockRejectedValueOnce(new Error("preview cleanup unavailable"));
        } else {
          deliverReplies.mockImplementationOnce(async (params) => {
            const result = await deliver(params);
            abortController.abort(new Error("turn cancelled after final acceptance"));
            return result;
          });
        }
        dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
          dispatchThroughSharedOwner({
            ...params,
            replyResolver: async (_ctx, options) => {
              await emitToolStart(options, {
                name: "exec",
                phase: "start",
                toolCallId: "cleanup-1",
              });
              return { text: "Accepted final survives cleanup" };
            },
          }),
        );

        await dispatchWithContext({
          bot,
          context: progressContext(status),
          streamMode: "progress",
          telegramCfg: progressConfig,
          retryDispatchErrors: true,
          turnAdoptionLifecycle: {
            abortSignal: abortController.signal,
            onAdopted: vi.fn(),
            onDeferred: vi.fn(),
            onAbandoned: vi.fn(),
          },
        });
        await vi.advanceTimersByTimeAsync(5_000);

        expect(
          [...messages.values()].filter((text) => text === "Accepted final survives cleanup"),
        ).toEqual(["Accepted final survives cleanup"]);
        if (interruption === "progress deletion failure") {
          expect([...messages.values()]).toEqual([
            expect.stringContaining("Exec"),
            "Accepted final survives cleanup",
          ]);
          expect(deleteMessage).toHaveBeenCalledOnce();
          expect(status.setDone).toHaveBeenCalledOnce();
        }
        expect(
          sendMessage.mock.calls.filter(([, text]) => text === "Accepted final survives cleanup"),
        ).toHaveLength(1);
        expect(deliverReplies).toHaveBeenCalledOnce();
        expect(status.setError).not.toHaveBeenCalled();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("keeps a queued followup visible when the preceding generation finishes cleanup", async () => {
    vi.useFakeTimers();
    try {
      const { bot, messages, sendMessage } = await setupObservedProgressTransport();
      let options: DispatchReplyWithBufferedBlockDispatcherArgs["replyOptions"];
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        options = params.replyOptions;
        return dispatchThroughSharedOwner({
          ...params,
          replyResolver: async (_ctx, replyOptions) => {
            await emitToolStart(replyOptions, {
              name: "exec",
              phase: "start",
              toolCallId: "parent-1",
            });
            return { text: "Parent final" };
          },
        });
      });

      await dispatchWithContext({
        bot,
        context: progressContext(),
        streamMode: "progress",
        telegramCfg: progressConfig,
      });
      await options?.onQueuedFollowupAdmitted?.();
      await emitToolStart(options, { name: "read", phase: "start", toolCallId: "followup-1" });
      await vi.advanceTimersByTimeAsync(5_000);

      expect([...messages.values()]).toEqual(["Parent final", expect.stringContaining("Read")]);
      expect(sendMessage.mock.calls.filter(([, text]) => text === "Parent final")).toHaveLength(1);

      await options?.onQueuedFollowupSettled?.();
      await vi.advanceTimersByTimeAsync(5_000);
      expect([...messages.values()]).toEqual(["Parent final"]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["accepted", "rejected"] as const)(
    "uses the second assistant preview as the current final when delivery is %s",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const { bot, messages, sendMessage, editMessageText } =
          await setupObservedProgressTransport();
        const status = createStatusReactionController();
        const first = "First accepted answer";
        const partial = "Second answer in progress while inspecting the result";
        const second = "Second complete answer";
        dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
          await params.dispatcherOptions.deliver({ text: first }, { kind: "final" });
          await params.replyOptions?.onAssistantMessageStart?.();
          await params.replyOptions?.onPartialReply?.({ text: partial });
          await createTelegramDraftStream.mock.results[0]?.value?.flush();
          expect([...messages.values()]).toEqual([first, partial]);
          if (outcome === "rejected") {
            editMessageText.mockRejectedValueOnce(new Error("second final edit rejected"));
            sendMessage.mockRejectedValueOnce(new Error("second final send rejected"));
          }
          return dispatchThroughSharedOwner({
            ...params,
            replyResolver: async () => ({ text: second }),
          });
        });
        await dispatchWithContext({
          bot,
          cfg: { channels: { telegram: { botToken: "synthetic-test-token" } } },
          context: progressContext(status),
          streamMode: "partial",
          telegramCfg: { streaming: { mode: "partial" } },
          retryDispatchErrors: true,
          suppressFailureFallback: true,
        });
        await vi.advanceTimersByTimeAsync(5_000);

        const visible = [...messages.entries()];
        expect(visible[0]?.[1]).toBe(first);
        expect(sendMessage.mock.calls.filter(([, text]) => text === first)).toHaveLength(1);
        if (outcome === "accepted") {
          expect(visible).toHaveLength(2);
          expect(visible[1]?.[1]).toBe(second);
          expect(sendMessage.mock.calls.filter(([, text]) => text === second)).toHaveLength(0);
          expect(status.setDone).toHaveBeenCalledOnce();
          expect(status.setError).not.toHaveBeenCalled();
        } else {
          expect(visible.some(([, text]) => text === second)).toBe(false);
          expect(visible.some(([, text]) => text.includes("OpenClaw chat history"))).toBe(true);
          expect(sendMessage.mock.calls.filter(([, text]) => text === second)).toHaveLength(1);
          expect(status.setError).toHaveBeenCalledOnce();
          expect(status.setDone).not.toHaveBeenCalled();
        }
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );
});
