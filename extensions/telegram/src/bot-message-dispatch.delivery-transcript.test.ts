import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createStructuredOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { dispatchReplyWithBufferedBlockDispatcher as dispatchThroughSharedOwner } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import type * as SessionStoreRuntime from "openclaw/plugin-sdk/session-store-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  drainSessionDiskBudgetWorkers,
  withSessionHistoryBudgetSweepsForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import {
  appendAssistantMirrorMessageByIdentity,
  createBot,
  createContext,
  createTelegramDraftStream,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  emitTelegramMessageSentHooks,
  readLatestAssistantTextByIdentity,
  telegramDepsForTest,
  type TelegramMessageContext,
  deliverInboundReplyWithMessageSendContext,
  expectDeliveredReply,
  expectDraftStreamParams,
  mockDefaultSessionEntry,
  setupDraftStreams,
} from "./bot-message-dispatch.test-harness.js";
import type * as TelegramDelivery from "./bot/delivery.replies.js";
import type * as TelegramDraft from "./draft-stream.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import type * as TelegramSendEdit from "./send-edit.js";

describeTelegramDispatch("dispatchTelegramMessage delivery-transcript", () => {
  it.each(["ordinary", "command"] as const)(
    "stores accepted %s finals without competing mirrors",
    async (kind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-dispatch-transcript-"));
      const scope = {
        agentId: "default",
        sessionId: "dispatch-transcript",
        sessionKey: "agent:default:telegram:direct:123",
        storePath: path.join(root, "sessions.json"),
      };
      const otherScope = {
        ...scope,
        sessionId: "unrelated-session",
        sessionKey: "agent:default:telegram:direct:999",
      };
      const transcript = await vi.importActual<typeof SessionTranscriptRuntime>(
        "openclaw/plugin-sdk/session-transcript-runtime",
      );
      const store = await vi.importActual<typeof SessionStoreRuntime>(
        "openclaw/plugin-sdk/session-store-runtime",
      );
      const actualDraft = await vi.importActual<typeof TelegramDraft>("./draft-stream.js");
      const actualDelivery = await vi.importActual<typeof TelegramDelivery>(
        "./bot/delivery.replies.js",
      );
      const actualEdit = await vi.importActual<typeof TelegramSendEdit>("./send-edit.js");
      const pendingMirrors: Promise<unknown>[] = [];
      appendAssistantMirrorMessageByIdentity.mockImplementation((params) => {
        const pending = transcript.appendAssistantMirrorMessageByIdentity(
          params as SessionTranscriptRuntime.SessionTranscriptAssistantMirrorAppendParams,
        );
        pendingMirrors.push(pending);
        return pending;
      });
      readLatestAssistantTextByIdentity.mockImplementation(
        transcript.readLatestAssistantTextByIdentity,
      );
      editMessageTelegram.mockImplementation(actualEdit.editMessageTelegram);
      let answer: TelegramDraftStream | undefined;
      createTelegramDraftStream.mockImplementation((params) => {
        const stream = actualDraft.createTelegramDraftStream(params);
        answer ??= stream;
        return stream;
      });
      const visible = new Map<number, string>();
      const bot = createBot();
      const chat = { id: 123, type: "private" as const, first_name: "Fixture" };
      let nextMessageId = 2001;
      vi.spyOn(bot.api, "sendMessage").mockImplementation(async (_chatId, text) => {
        const message_id = nextMessageId++;
        visible.set(message_id, text);
        return { chat, message_id, text, date: 1 };
      });
      vi.spyOn(bot.api, "editMessageText").mockImplementation(async (_chatId, messageId, text) => {
        if (typeof text !== "string") {
          throw new Error("Expected a text edit, not a rich-message edit");
        }
        visible.set(messageId, text);
        return { chat, message_id: messageId, text, date: 1, edit_date: 2 };
      });
      vi.spyOn(bot.api, "deleteMessage").mockImplementation(async (_chatId, messageId) => {
        visible.delete(messageId);
        return true;
      });
      let restoreClock: (() => void) | undefined;
      const sourceMessageIds: string[] = [];
      try {
        for (const session of [scope, otherScope]) {
          const entry = { sessionId: session.sessionId, updatedAt: Date.now() };
          await patchSessionEntry({ ...session, fallbackEntry: entry, update: () => entry });
        }
        const timestamp = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
        restoreClock = () => clock.mockRestore();
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async (params) => {
          const { dispatcherOptions, replyOptions } = params;
          await replyOptions?.onPartialReply?.({ text: "Final answer" });
          await answer?.flush();
          if (kind === "command") {
            return dispatchThroughSharedOwner({
              ...params,
              replyResolver: async () => ({ text: "Final answer" }),
            });
          }
          const runId = `run-${sourceMessageIds.length}`;
          replyOptions?.onAgentRunStart?.(runId);
          const manager = SessionManager.open(scope, root);
          const sourceAssistant = {
            ...makeAgentAssistantMessage({
              content: [{ type: "text", text: "Final answer" }],
            }),
            __openclaw: { runId },
          };
          sourceMessageIds.push(manager.appendMessage(sourceAssistant));
          manager.appendMessage({ role: "user", content: "Queued input", timestamp: Date.now() });
          await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
          await dispatcherOptions.deliver(
            { text: "Tool output must not become a final mirror" },
            { kind: "tool" },
          );
          return { queuedFinal: true, counts: { block: 0, final: 1, tool: 1 } };
        });
        for (const inboundId of [456, 457]) {
          SessionManager.open(scope, root).appendMessage({
            role: "user",
            content: "Repeat the answer",
            timestamp: Date.now(),
          });
          answer = undefined;
          await dispatchWithContext({
            ...(kind === "command"
              ? {
                  cfg: {
                    session: { store: scope.storePath },
                    agents: { entries: { default: {} } },
                  },
                }
              : {}),
            context: createContext({
              chatId: chat.id,
              isGroup: false,
              msg: { chat, message_id: inboundId } as TelegramMessageContext["msg"],
              threadSpec: { scope: "none", id: undefined },
              replyThreadId: undefined,
              ctxPayload: {
                SessionKey: scope.sessionKey,
                MessageSid: String(inboundId),
                ChatType: "direct",
                ...(kind === "command"
                  ? {
                      Body: "/status",
                      BodyForCommands: "/status",
                      Provider: "telegram",
                      Surface: "telegram",
                      OriginatingChannel: "telegram",
                      From: "telegram:123",
                      To: "telegram:123",
                    }
                  : {}),
              } as TelegramMessageContext["ctxPayload"],
            }),
            bot,
            streamMode: "partial",
            telegramDeps: {
              ...telegramDepsForTest,
              resolveStorePath: () => scope.storePath,
              getSessionEntry: store.getSessionEntry,
              deliverReplies: actualDelivery.deliverReplies,
              deliverStructuredReplies: actualDelivery.deliverStructuredReplies,
            },
          });
          await Promise.all(pendingMirrors);
        }
        const entries = await transcript.readVisibleSessionTranscriptMessageEntries(scope);
        const mirrors = entries.filter(
          (
            entry,
          ): entry is typeof entry & {
            message: Extract<typeof entry.message, { role: "assistant" }>;
          } => entry.message.role === "assistant" && entry.message.model === "delivery-mirror",
        );
        expect(mirrors.map(({ message }) => message.content)).toEqual(
          kind === "command"
            ? []
            : [[{ type: "text", text: "Final answer" }], [{ type: "text", text: "Final answer" }]],
        );
        expect(await transcript.readVisibleSessionTranscriptMessageEntries(otherScope)).toEqual([]);
        if (kind === "ordinary") {
          expect(mirrors[0]?.idempotencyKey).not.toBe(mirrors[1]?.idempotencyKey);
          expect(mirrors.map(({ message }) => message)).toMatchObject(
            sourceMessageIds.map((sourceAssistantMessageId) => ({
              openclawDeliveryMirror: { sourceAssistantMessageId },
            })),
          );
        } else {
          expect(entries.filter((entry) => entry.message.role === "assistant")).toHaveLength(2);
          expect(
            entries.filter((entry) => JSON.stringify(entry.message).includes("/status")),
          ).toHaveLength(2);
        }
        expect([...visible.values()]).toEqual(["Final answer", "Final answer"]);
        const finalHooks = emitTelegramMessageSentHooks.mock.calls.filter(
          ([event]) => event.content === "Final answer",
        );
        expect(finalHooks).toHaveLength(2);
        expect(finalHooks[0]?.[0]).toMatchObject({
          content: "Final answer",
          success: true,
          sessionKeyForInternalHooks: scope.sessionKey,
        });
      } finally {
        restoreClock?.();
        await Promise.all(pendingMirrors);
        await closeQaRuntimeStores(root);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describeTelegramDispatch("dispatchTelegramMessage directive delivery", () => {
  it("recovers persisted delivery facts without replacing the current-message target", async () => {
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
                  text: `${fullText} [[reply_to:999]] [[audio_as_voice]]`,
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
              replyToCurrent: true,
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
        streamMode: "partial",
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
            replyToId: "456",
            replyToCurrent: true,
            replyToTag: true,
            audioAsVoice: true,
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
  });

  it.each([
    "longer preview",
    "recovered current-message target",
    "initial current-message target",
  ] as const)("retains delivery intent with %s", async (recovery) => {
    const current = recovery !== "longer preview";
    const initialTarget = recovery === "initial current-message target";
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    context.ctxPayload.MessageSid = "456";
    mockDefaultSessionEntry();
    const prefix = "The recovered answer includes the remaining explanation after this opening";
    const fullText = `${prefix} paragraph with the complete explanation.`;
    const previewText = current ? prefix : `${fullText} The preview also includes the last step.`;
    readLatestAssistantTextByIdentity.mockResolvedValueOnce(undefined).mockResolvedValue({
      text: current
        ? `${fullText} [[reply_to_current]]`
        : `${fullText} [[reply_to:999]] [[audio_as_voice]]\nMEDIA:https://example.invalid/note.ogg`,
      timestamp: Date.now() + 1_000,
    });
    if (current) {
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["2002"], visibleReplySent: true },
      });
    }
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: previewText });
        const [plan] = createStructuredOutboundPayloadPlan([
          initialTarget
            ? { text: fullText, replyToId: "456", replyToTag: true, replyToCurrent: true }
            : { text: `${prefix}...` },
        ]);
        if (!plan || !dispatcherOptions.deliverPrepared) {
          throw new Error("Prepared Telegram delivery operation missing");
        }
        await dispatcherOptions.deliverPrepared(plan, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    await dispatchWithContext({ context, replyToMode: current ? "off" : "all" });
    expect(answerDraftStream.update).toHaveBeenCalledWith(previewText);
    if (current) {
      expectDraftStreamParams({ replyToMessageId: undefined, replyToMode: "off" });
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
    } else {
      expectDeliveredReply(0, {
        text: previewText,
        mediaUrls: ["https://example.invalid/note.ogg"],
        audioAsVoice: true,
        replyToId: "999",
        replyToTag: true,
      });
    }
  });
});
