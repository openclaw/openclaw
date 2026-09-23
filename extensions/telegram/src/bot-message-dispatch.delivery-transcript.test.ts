import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type * as SessionStoreRuntime from "openclaw/plugin-sdk/session-store-runtime";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
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
} from "./bot-message-dispatch.test-harness.js";
import type * as TelegramDelivery from "./bot/delivery.replies.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import type * as TelegramDraft from "./draft-stream.js";
import type * as TelegramSendEdit from "./send-edit.js";

describeTelegramDispatch("dispatchTelegramMessage delivery-transcript", () => {
  it.each(["same-millisecond turns", "tool exclusion"] as const)(
    "stores only accepted final text with scoped transcript identities (%s)",
    async (scenario) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-dispatch-transcript-"));
      const repeated = scenario === "same-millisecond turns";
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
      try {
        for (const session of [scope, otherScope]) {
          const entry = { sessionId: session.sessionId, updatedAt: Date.now() };
          await patchSessionEntry({ ...session, fallbackEntry: entry, update: () => entry });
        }
        if (repeated) {
          const timestamp = Date.now();
          const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
          restoreClock = () => clock.mockRestore();
        }
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            if (repeated) {
              await replyOptions?.onPartialReply?.({ text: "Final answer" });
              await answer?.flush();
            } else {
              await dispatcherOptions.deliver(
                { text: "Tool output must not become a final mirror" },
                { kind: "tool" },
              );
            }
            await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
            await dispatcherOptions.deliver(
              { text: "Tool output must not become a final mirror" },
              { kind: "tool" },
            );
            return { queuedFinal: true, counts: { block: 0, final: 1, tool: 1 } };
          },
        );
        for (const inboundId of repeated ? [456, 457] : [456]) {
          SessionManager.open(scope, root).appendMessage({
            role: "user",
            content: "Repeat the answer",
            timestamp: Date.now(),
          });
          answer = undefined;
          await dispatchWithContext({
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
              } as TelegramMessageContext["ctxPayload"],
            }),
            bot,
            streamMode: repeated ? "partial" : "off",
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
          repeated
            ? [[{ type: "text", text: "Final answer" }], [{ type: "text", text: "Final answer" }]]
            : [[{ type: "text", text: "Final answer" }]],
        );
        expect(await transcript.readVisibleSessionTranscriptMessageEntries(otherScope)).toEqual([]);
        if (repeated) {
          expect(mirrors[0]?.idempotencyKey).not.toBe(mirrors[1]?.idempotencyKey);
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
        } else {
          expect([...visible.values()]).toEqual([
            "Tool output must not become a final mirror",
            "Final answer",
          ]);
        }
      } finally {
        restoreClock?.();
        await Promise.all(pendingMirrors);
        await closeQaRuntimeStores(root);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
