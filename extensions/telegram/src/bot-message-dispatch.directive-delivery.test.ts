import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createStructuredOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { isReplyPayloadNonTerminalToolErrorWarning } from "openclaw/plugin-sdk/reply-payload";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  drainSessionDiskBudgetWorkers,
  withSessionHistoryBudgetSweepsForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectDeliveredReply,
  expectDraftStreamParams,
  mockDefaultSessionEntry,
  readLatestAssistantTextByIdentity,
  setupDraftStreams,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";
import { resolveTelegramPromptContextSource } from "./prompt-context-projection.js";

describeTelegramDispatch("dispatchTelegramMessage directive delivery", () => {
  it.each([
    {
      name: "matching transcript signature",
      existingTarget: undefined,
      existingCurrent: false,
      preceding: false,
      stale: false,
    },
    {
      name: "new target",
      existingTarget: undefined,
      existingCurrent: false,
      preceding: false,
      stale: false,
    },
    {
      name: "existing target",
      existingTarget: "42",
      existingCurrent: false,
      preceding: false,
      stale: false,
    },
    {
      name: "existing current-message target",
      existingTarget: undefined,
      existingCurrent: true,
      preceding: false,
      stale: false,
    },
    {
      name: "initial recovery after block media",
      existingTarget: undefined,
      existingCurrent: false,
      preceding: false,
      stale: false,
    },
    {
      name: "late recovery after block media",
      existingTarget: undefined,
      existingCurrent: false,
      preceding: false,
      stale: false,
    },
    {
      name: "preceding input after block media",
      existingTarget: undefined,
      existingCurrent: false,
      preceding: true,
      stale: false,
    },
    {
      name: "preceding input",
      existingTarget: undefined,
      existingCurrent: false,
      preceding: true,
      stale: false,
    },
    {
      name: "prior turn",
      existingTarget: undefined,
      existingCurrent: false,
      preceding: false,
      stale: true,
    },
  ] as const)(
    "recovers persisted delivery facts through the scoped transcript SDK ($name)",
    async ({ name, existingTarget, existingCurrent, preceding, stale }) => {
      const extraMedia = name !== "matching transcript signature";
      const lateRecovery = name === "late recovery after block media";
      const recoveredBlockMedia = lateRecovery || name === "initial recovery after block media";
      const blockMedia = recoveredBlockMedia || name === "preceding input after block media";
      const recover = !preceding && !stale;
      const streaming = recover && existingTarget === undefined;
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-persisted-recovery-"));
      const scope = {
        agentId: "default",
        sessionId: "persisted-recovery",
        sessionKey: "agent:default:telegram:direct:123",
        storePath: path.join(root, "sessions.json"),
      };
      const entry = { sessionId: scope.sessionId, updatedAt: Date.now() };
      const prefix = "The persisted answer continues after this sufficiently long stable opening";
      const literalExamples = [
        "```text",
        "MEDIA:/tmp/fenced-literal.png",
        "```",
        "",
        "    MEDIA:/tmp/indented-literal.png",
      ].join("\n");
      const fullText = `${prefix} paragraph with the remaining explanation and its voice attachment.${extraMedia ? "" : `\n\n${literalExamples}\n\nThe complete answer ends here.`}`;
      const rawMediaUrls = extraMedia ? [] : ["/tmp/actual-attachment.txt"];
      const transcriptText = `${fullText}${rawMediaUrls.map((url) => `\n\nMEDIA:${url}`).join("")}`;
      const aliasRecord = {
        filePath: "/tmp/source-note.txt",
        name: "Displayed attachment.txt",
        mimeType: "text/plain",
      };
      const mediaUrls = extraMedia ? ["/tmp/lead.txt", aliasRecord.filePath] : [];
      const recordedMedia = "/tmp/recorded.ogg";
      const persistedMediaUrls = recoveredBlockMedia
        ? [...mediaUrls, recordedMedia]
        : [recordedMedia];
      const sentAttachment = { name: "Already delivered.txt", mimeType: "text/plain" };
      const remainingAttachment = { name: "Still needed.txt", mimeType: "text/plain" };
      const attachments = recoveredBlockMedia
        ? [sentAttachment, remainingAttachment]
        : [aliasRecord];
      let transcriptMessageId: string | undefined;
      try {
        await withSessionHistoryBudgetSweepsForTest(() =>
          patchSessionEntry({ ...scope, fallbackEntry: entry, update: () => entry }),
        );
        const manager = SessionManager.open(scope, root);
        const transcript = await vi.importActual<
          typeof import("openclaw/plugin-sdk/session-transcript-runtime")
        >("openclaw/plugin-sdk/session-transcript-runtime");
        readLatestAssistantTextByIdentity.mockImplementation(
          transcript.readLatestAssistantTextByIdentity,
        );
        const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
        const context = createContext();
        context.ctxPayload.SessionKey = scope.sessionKey;
        context.ctxPayload.MessageSid = "456";
        deliverInboundReplyWithMessageSendContext.mockResolvedValue({
          status: "handled_visible",
          delivery: { messageIds: ["2002"], visibleReplySent: true },
        });
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            await replyOptions?.onPartialReply?.({ text: prefix });
            if (blockMedia) {
              const [blockPlan] = createStructuredOutboundPayloadPlan([
                {
                  mediaUrl: mediaUrls[0],
                  ...(recoveredBlockMedia ? { attachments: [sentAttachment] } : {}),
                },
              ]);
              if (!blockPlan || !dispatcherOptions.deliverPrepared) {
                throw new Error("Prepared block delivery missing");
              }
              await dispatcherOptions.deliverPrepared(blockPlan, { kind: "block" });
              expectDeliveredReply(0, { mediaUrls: [mediaUrls[0]] });
            }
            const persistReply = () => {
              transcriptMessageId = manager.appendMessage({
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: `${transcriptText} ${existingCurrent ? "[[reply_to:999]]" : "[[reply_to_current]]"} [[audio_as_voice]]`,
                  },
                ],
                openclawDelivery: { mediaUrls: persistedMediaUrls },
                api: "openai-responses",
                provider: "openai",
                model: "gpt-test",
                stopReason: "stop",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                timestamp: stale ? Date.now() - 60_000 : Date.now(),
              });
              const persisted = manager.getBranch().at(-1);
              expect(persisted).toMatchObject({
                type: "message",
                message: {
                  content: [{ type: "text", text: transcriptText }],
                  openclawDelivery: {
                    ...(existingCurrent ? { replyToId: "999" } : { replyToCurrent: true }),
                    audioAsVoice: true,
                    mediaUrls: persistedMediaUrls,
                  },
                },
              });
            };
            if (lateRecovery) {
              readLatestAssistantTextByIdentity.mockImplementationOnce(async (identity) => {
                const latest = await transcript.readLatestAssistantTextByIdentity(identity);
                expect(latest).toBeUndefined();
                persistReply();
                return latest;
              });
            } else {
              persistReply();
            }
            const payload = setReplyPayloadMetadata(
              {
                text: `${prefix}...`,
                ...(extraMedia ? { mediaUrls, mediaUrl: aliasRecord.filePath, attachments } : {}),
                ...(existingTarget ? { replyToId: existingTarget, audioAsVoice: false } : {}),
                ...(existingCurrent
                  ? { replyToCurrent: true }
                  : name === "new target"
                    ? { replyToCurrent: false }
                    : {}),
              },
              {
                ...(preceding ? { precedingInputAnswer: true } : {}),
                nonTerminalToolErrorWarning: true,
                tts: { tagged: true, text: "Host-owned spoken answer" },
              },
            );
            const [plan] = createStructuredOutboundPayloadPlan([payload]);
            if (!plan || !dispatcherOptions.deliverPrepared) {
              throw new Error("Prepared delivery missing");
            }
            await dispatcherOptions.deliverPrepared(plan, { kind: "final" });
            return { queuedFinal: true };
          },
        );
        await dispatchWithContext({
          context,
          replyToMode: "off",
          streamMode: streaming ? "partial" : "off",
          telegramDeps: {
            ...telegramDepsForTest,
            resolveStorePath: () => scope.storePath,
            getSessionEntry: () => entry,
          },
        });
        expect(readLatestAssistantTextByIdentity).toHaveBeenCalledWith(scope);
        expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({
              text: recover ? fullText : `${prefix}...`,
              ...(recover
                ? {
                    replyToId: existingTarget ?? "456",
                    replyToCurrent: existingTarget ? undefined : true,
                    replyToTag: !existingTarget,
                    audioAsVoice: !existingTarget,
                  }
                : {}),
              mediaUrls: recover
                ? [
                    ...(recoveredBlockMedia ? mediaUrls.slice(1) : mediaUrls),
                    ...rawMediaUrls,
                    recordedMedia,
                  ]
                : blockMedia
                  ? mediaUrls.slice(1)
                  : mediaUrls,
              ...(recoveredBlockMedia ? { attachments: [remainingAttachment, {}] } : {}),
              ...(extraMedia && !blockMedia
                ? { attachments: recover ? [{}, aliasRecord, {}] : [{}, aliasRecord] }
                : {}),
            }),
          }),
        );
        const deliveredPayload =
          deliverInboundReplyWithMessageSendContext.mock.calls[0]?.[0]?.payload;
        if (recoveredBlockMedia) {
          expect(deliverReplies).toHaveBeenCalledOnce();
          expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledOnce();
          expect(
            deliveredPayload && resolveTelegramPromptContextSource(deliveredPayload),
          ).toBeUndefined();
        }
        if (!extraMedia) {
          expect(deliveredPayload && resolveTelegramPromptContextSource(deliveredPayload)).toEqual({
            transcriptMessageId,
          });
        }
        expect(
          deliveredPayload && isReplyPayloadNonTerminalToolErrorWarning(deliveredPayload),
        ).toBe(true);
        if (streaming) {
          expect(answerDraftStream.clear).toHaveBeenCalledOnce();
        }
        if (!recover) {
          const payload = deliverInboundReplyWithMessageSendContext.mock.calls[0]?.[0]?.payload;
          expect(payload?.replyToId).toBeUndefined();
          expect(payload?.audioAsVoice).not.toBe(true);
        }
        expect(answerDraftStream.update).not.toHaveBeenCalledWith(fullText);
      } finally {
        await drainSessionDiskBudgetWorkers();
        await closeQaRuntimeStores(root);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

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
        expect(sendVoice.mock.calls[0]?.[2]).toMatchObject({
          caption: "Example",
          reply_to_message_id: 999,
        });
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

  it.each([
    { lookup: "initial", media: false },
    { lookup: "late", media: false },
    { lookup: "initial", media: true },
  ] as const)(
    "resolves $lookup transcript reply-to-current intent before reusing an unthreaded preview (media: $media)",
    async ({ lookup, media }) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      const context = createContext();
      context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
      context.ctxPayload.MessageSid = "456";
      mockDefaultSessionEntry();
      const prefix = "The recovered answer includes the remaining explanation after this opening";
      const fullText = `${prefix} paragraph and replies directly to the triggering message.`;
      const aliasRecord = {
        filePath: "/tmp/source-note.txt",
        name: "PR146361-displayed-alias.txt",
        mimeType: "text/plain",
      };
      const mediaUrls = ["/tmp/lead.txt", aliasRecord.filePath];
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
          const [plan] = createStructuredOutboundPayloadPlan([
            {
              text: `${prefix}...`,
              ...(media
                ? { mediaUrls, mediaUrl: aliasRecord.filePath, attachments: [aliasRecord] }
                : {}),
            },
          ]);
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
      expect(answerDraftStream.clear).toHaveBeenCalledOnce();
      if (media) {
        const payload = deliverInboundReplyWithMessageSendContext.mock.calls[0]?.[0]?.payload;
        expect(payload?.mediaUrls).toEqual(mediaUrls);
        expect(payload?.attachments).toEqual([{}, aliasRecord]);
        expect(payload?.mediaUrl).toBeUndefined();
      }
    },
  );
});
