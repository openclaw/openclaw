import { createStructuredOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  deliverInboundReplyWithMessageSendContext,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectDeliveredReply,
  expectDraftStreamParams,
  mockDefaultSessionEntry,
  readLatestAssistantTextByIdentity,
  setupDraftStreams,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage directive delivery", () => {
  it.each(["raw", "prepared"] as const)(
    "keeps the %s ingress contract through the registered Telegram media sender",
    async (source) => {
      const delivery = await vi.importActual<typeof import("./bot/delivery.replies.js")>(
        "./bot/delivery.replies.js",
      );
      const bot = createBot();
      const sendMessage = vi.spyOn(bot.api, "sendMessage");
      const sendAudio = vi.fn().mockResolvedValue({
        message_id: 2001,
        message_thread_id: 777,
        chat: { id: "123" },
      });
      const sendVoice = vi.fn().mockResolvedValue({
        message_id: 2002,
        message_thread_id: 777,
        chat: { id: "123" },
      });
      bot.api.sendAudio = sendAudio;
      bot.api.sendVoice = sendVoice;
      const text = "[[reply_to:999]] [[audio_as_voice]] Example";
      const payload = { text, mediaUrl: "https://example.invalid/note.ogg" };
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        if (source === "prepared") {
          const [plan] = createStructuredOutboundPayloadPlan([payload]);
          if (!plan || !dispatcherOptions.deliverPrepared) {
            throw new Error("Prepared Telegram delivery operation missing");
          }
          await dispatcherOptions.deliverPrepared(plan, { kind: "final" });
        } else {
          await dispatcherOptions.deliver(payload, { kind: "final" });
        }
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        bot,
        streamMode: "off",
        replyToMode: "all",
        telegramDeps: {
          ...telegramDepsForTest,
          deliverReplies: delivery.deliverReplies,
          deliverStructuredReplies: delivery.deliverStructuredReplies,
          loadWebMedia: vi.fn().mockResolvedValue({
            buffer: Buffer.from("synthetic audio"),
            contentType: "audio/ogg",
            fileName: "note.ogg",
          }),
        },
      });

      expect(sendMessage).not.toHaveBeenCalled();
      const sender = source === "prepared" ? sendAudio : sendVoice;
      expect(sender.mock.calls[0]?.[2]).toMatchObject({ message_thread_id: 777 });
      if (source === "prepared") {
        expect(sendAudio).toHaveBeenCalledTimes(1);
        expect(sendVoice).not.toHaveBeenCalled();
        expect(sendAudio.mock.calls[0]?.[2]).toMatchObject({ caption: text });
        expect(sendAudio.mock.calls[0]?.[2]).not.toHaveProperty("reply_to_message_id", 999);
        expect(sendAudio.mock.calls[0]?.[2]).not.toHaveProperty("reply_parameters");
      } else {
        expect(sendVoice).toHaveBeenCalledTimes(1);
        expect(sendAudio).not.toHaveBeenCalled();
        expect(sendVoice.mock.calls[0]?.[2]).toMatchObject({ reply_to_message_id: 999 });
      }
    },
  );

  it.each(["none", "intermediate", "full", "longer"] as const)(
    "keeps the complete reply and late transcript delivery intent (preview: %s)",
    async (preview) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      const context = createContext();
      context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
      mockDefaultSessionEntry();
      const prefix = "The recovered answer includes the remaining explanation after this opening";
      const fullText = `${prefix} paragraph, together with the requested audio attachment.`;
      const previewText = {
        none: undefined,
        intermediate: `${prefix} paragraph, together with the requested`,
        full: fullText,
        longer: `${fullText} The preview also includes the last step.`,
      }[preview];
      const expectedText = preview === "longer" ? previewText : fullText;
      readLatestAssistantTextByIdentity.mockResolvedValueOnce(undefined).mockResolvedValue({
        text: `${fullText} [[reply_to:999]] [[audio_as_voice]]\nMEDIA:https://example.invalid/note.ogg`,
        timestamp: Date.now() + 1_000,
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          if (previewText) {
            await replyOptions?.onPartialReply?.({ text: previewText });
          }
          const [plan] = createStructuredOutboundPayloadPlan([{ text: `${prefix}...` }]);
          if (!plan || !dispatcherOptions.deliverPrepared) {
            throw new Error("Prepared Telegram delivery operation missing");
          }
          await dispatcherOptions.deliverPrepared(plan, { kind: "final" });
          return { queuedFinal: true };
        },
      );

      await dispatchWithContext({ context, replyToMode: "all" });

      if (previewText) {
        expect(answerDraftStream.update).toHaveBeenCalledWith(previewText);
      } else {
        expect(answerDraftStream.update).not.toHaveBeenCalled();
      }
      expectDeliveredReply(0, {
        text: expectedText,
        mediaUrls: ["https://example.invalid/note.ogg"],
        audioAsVoice: true,
        replyToId: "999",
        replyToTag: true,
      });
    },
  );

  it.each(["initial", "late"] as const)(
    "resolves %s transcript reply-to-current intent before reusing an unthreaded preview",
    async (lookup) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      const context = createContext();
      context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
      context.ctxPayload.MessageSid = "456";
      mockDefaultSessionEntry();
      const prefix = "The recovered answer includes the remaining explanation after this opening";
      const fullText = `${prefix} paragraph and replies directly to the triggering message.`;
      if (lookup === "late") {
        readLatestAssistantTextByIdentity.mockResolvedValueOnce(undefined);
      }
      readLatestAssistantTextByIdentity.mockResolvedValue({
        text: `${fullText} [[reply_to_current]]`,
        timestamp: Date.now() + 1_000,
      });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["2002"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onPartialReply?.({ text: prefix });
          const [plan] = createStructuredOutboundPayloadPlan([{ text: `${prefix}...` }]);
          if (!plan || !dispatcherOptions.deliverPrepared) {
            throw new Error("Prepared Telegram delivery operation missing");
          }
          await dispatcherOptions.deliverPrepared(plan, { kind: "final" });
          return { queuedFinal: true };
        },
      );

      await dispatchWithContext({ context, replyToMode: "off" });

      expectDraftStreamParams({ replyToMessageId: undefined, replyToMode: "off" });
      expect(answerDraftStream.update).toHaveBeenCalledWith(prefix);
      expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledWith(
        expect.objectContaining({
          replyToMode: "off",
          payload: expect.objectContaining({
            text: fullText,
            replyToId: "456",
            replyToTag: true,
            replyToCurrent: true,
          }),
        }),
      );
      expect(answerDraftStream.update).not.toHaveBeenCalledWith(fullText);
    },
  );
});
