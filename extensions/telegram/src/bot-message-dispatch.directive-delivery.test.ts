import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createStructuredOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  drainSessionDiskBudgetWorkers,
  withSessionHistoryBudgetSweepsForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import {
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
  it.each([
    { name: "existing target", existingTarget: "42", existingCurrent: false },
    { name: "existing current-message target", existingTarget: undefined, existingCurrent: true },
  ] as const)(
    "recovers persisted delivery facts without replacing $name",
    async ({ existingTarget, existingCurrent }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-persisted-recovery-"));
      const scope = {
        agentId: "default",
        sessionId: "persisted-recovery",
        sessionKey: "agent:default:telegram:direct:123",
        storePath: path.join(root, "sessions.json"),
      };
      const entry = { sessionId: scope.sessionId, updatedAt: Date.now() };
      const prefix = "The persisted answer continues after this sufficiently long stable opening";
      const fullText = `${prefix} paragraph with the remaining explanation and its voice attachment.`;
      const aliasRecord = {
        filePath: "/tmp/source-note.txt",
        name: "Displayed attachment.txt",
        mimeType: "text/plain",
      };
      const mediaUrls = ["/tmp/lead.txt", aliasRecord.filePath];
      const recordedMedia = "/tmp/recorded.ogg";
      try {
        await withSessionHistoryBudgetSweepsForTest(() =>
          patchSessionEntry({ ...scope, fallbackEntry: entry, update: () => entry }),
        );
        const manager = SessionManager.open(scope, root);
        const transcript = await vi.importActual<typeof SessionTranscriptRuntime>(
          "openclaw/plugin-sdk/session-transcript-runtime",
        );
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
            manager.appendMessage({
              ...makeAgentAssistantMessage({
                content: [
                  {
                    type: "text",
                    text: `${fullText} ${existingCurrent ? "[[reply_to:999]]" : "[[reply_to_current]]"} [[audio_as_voice]]`,
                  },
                ],
                timestamp: Date.now(),
              }),
              openclawDelivery: { mediaUrls: [recordedMedia] },
            });
            const payload = setReplyPayloadMetadata(
              {
                text: `${prefix}...`,
                mediaUrls,
                mediaUrl: aliasRecord.filePath,
                attachments: [aliasRecord],
                ...(existingTarget ? { replyToId: existingTarget, audioAsVoice: false } : {}),
                ...(existingCurrent ? { replyToCurrent: true } : {}),
              },
              {
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
          streamMode: existingTarget ? "off" : "partial",
          telegramDeps: {
            ...telegramDepsForTest,
            resolveStorePath: () => scope.storePath,
            getSessionEntry: () => entry,
          },
        });
        expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({
              text: fullText,
              replyToId: existingTarget ?? "456",
              replyToCurrent: existingTarget ? undefined : true,
              replyToTag: !existingTarget,
              audioAsVoice: !existingTarget,
              mediaUrls: [...mediaUrls, recordedMedia],
              attachments: [{}, aliasRecord, {}],
            }),
          }),
        );
        expect(answerDraftStream.update).not.toHaveBeenCalledWith(fullText);
      } finally {
        await drainSessionDiskBudgetWorkers();
        await closeQaRuntimeStores(root);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps the complete longer preview and late transcript delivery intent", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    const prefix = "The recovered answer includes the remaining explanation after this opening";
    const fullText = `${prefix} paragraph, together with the requested audio attachment.`;
    const previewText = `${fullText} The preview also includes the last step.`;
    readLatestAssistantTextByIdentity.mockResolvedValueOnce(undefined).mockResolvedValue({
      text: `${fullText} [[reply_to:999]] [[audio_as_voice]]\nMEDIA:https://example.invalid/note.ogg`,
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: previewText });
        const [plan] = createStructuredOutboundPayloadPlan([{ text: `${prefix}...` }]);
        if (!plan || !dispatcherOptions.deliverPrepared) {
          throw new Error("Prepared Telegram delivery operation missing");
        }
        await dispatcherOptions.deliverPrepared(plan, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    await dispatchWithContext({ context, replyToMode: "all" });
    expect(answerDraftStream.update).toHaveBeenCalledWith(previewText);
    expectDeliveredReply(0, {
      text: previewText,
      mediaUrls: ["https://example.invalid/note.ogg"],
      audioAsVoice: true,
      replyToId: "999",
      replyToTag: true,
    });
  });

  it.each([
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
      if (media) {
        const payload = deliverInboundReplyWithMessageSendContext.mock.calls[0]?.[0]?.payload;
        expect(payload?.mediaUrls).toEqual(mediaUrls);
        expect(payload?.attachments).toEqual([{}, aliasRecord]);
        expect(payload?.mediaUrl).toBeUndefined();
      }
    },
  );
});
