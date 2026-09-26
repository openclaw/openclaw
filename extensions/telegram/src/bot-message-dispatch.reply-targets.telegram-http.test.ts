import fs from "node:fs/promises";
import path from "node:path";
import type { Message } from "grammy/types";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createStatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import { resolveGroupThreadMentionFacts } from "openclaw/plugin-sdk/channel-inbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  getSessionEntry,
  patchSessionEntry,
  sessionDeliveryOrigin,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { reactMessageTelegram } from "./send.js";
import { resolveTelegramTestUpload } from "./send.telegram-http.test-support.js";
import { wasSentByBot } from "./sent-message-cache.js";

describe("Telegram quote selection and accepted reply targets through HTTP", () => {
  const http = createTelegramDispatchHttpFixture();
  const {
    calls,
    visibleMessages,
    acceptedCalls,
    createContext,
    emitToolStart,
    dispatchProgressTurn,
    waitForBotApiCall,
  } = http;

  it.each(["selected", "bot-reply", "older-source", "external", "off"] as const)(
    "selects the native reply target from %s context",
    async (selection) => {
      const context = createContext();
      const inboundId = context.msg.message_id;
      Object.assign(context.ctxPayload, {
        ReplyToId: "9001",
        ReplyToBody: "trimmed display body",
        ReplyToQuoteText: " quoted slice\n",
        ReplyToQuotePosition: 12,
        ReplyToQuoteEntities: [{ type: "italic", offset: 1, length: 6 }],
        ReplyToIsQuote: selection !== "older-source",
        ReplyToIsExternal: selection === "external",
        ReplyToQuoteSourceText: "  exact older source",
        ReplyToQuoteSourceEntities: [{ type: "bold", offset: 2, length: 5 }],
      });
      if (selection === "bot-reply") {
        context.msg.reply_to_message = {
          ...context.msg,
          message_id: 9001,
          from: { id: 99, is_bot: true, first_name: "Fixture bot" },
          reply_to_message: undefined,
        };
      }
      const preview = "A sufficiently long answer preview for the selected conversation.";
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({ text: preview });
          if (selection === "off" || selection === "older-source") {
            await waitForBotApiCall((call) => call.method === "sendMessage");
            expect([...visibleMessages.values()]).toEqual([preview]);
            if (selection === "older-source") {
              expect(
                acceptedCalls.find((call) => call.method === "sendMessage")?.fields
                  .reply_parameters,
              ).toMatchObject({ message_id: inboundId });
            }
          }
        },
        {
          mode: "partial",
          toolProgress: false,
          context,
          replyToMode: selection === "off" ? "off" : "first",
          finalReply: {
            text: "The selected answer.",
            ...(selection === "off"
              ? {}
              : { replyToId: String(selection === "older-source" ? 9001 : inboundId) }),
          },
        },
      );
      const sends = acceptedCalls.filter((call) => call.method === "sendMessage");
      const final = sends.at(-1)?.fields;
      if (selection === "selected") {
        expect(final?.reply_parameters).toMatchObject({
          message_id: 9001,
          quote: " quoted slice\n",
          quote_position: 12,
          quote_entities: [{ type: "italic", offset: 1, length: 6 }],
        });
      } else if (selection === "older-source") {
        expect(final?.reply_parameters).toMatchObject({
          message_id: 9001,
          quote: "  exact older source",
          quote_position: 0,
          quote_entities: [{ type: "bold", offset: 2, length: 5 }],
        });
        expect(sends.filter((call) => call.fields.text === "The selected answer.")).toHaveLength(1);
        // Changing the target retires the old preview after its minimum visible dwell.
        await vi.advanceTimersByTimeAsync(4_000);
        await waitForBotApiCall(
          (call) => call.method === "deleteMessage" && Number(call.fields.message_id) === 1,
        );
        expect(
          calls.some((call) => call.method === "editMessageText" && call.fields.message_id === 1),
        ).toBe(false);
        expect([...visibleMessages]).toEqual([[2, "The selected answer."]]);
      } else if (selection === "off") {
        expect(sends).toHaveLength(1);
        expect(final).not.toHaveProperty("reply_parameters");
        expect(final).not.toHaveProperty("reply_to_message_id");
      } else {
        expect(final?.reply_parameters).toMatchObject({ message_id: inboundId });
        expect(JSON.stringify(final)).not.toContain("quoted slice");
        expect(JSON.stringify(final)).not.toContain("9001");
      }
      expect([...visibleMessages.values()]).toEqual(["The selected answer."]);
    },
  );

  it.each(
    (["first", "batched", "all"] as const).flatMap((replyToMode) =>
      (["one-page", "retained-page", "media"] as const).map((transition) => ({
        replyToMode,
        transition,
      })),
    ),
  )(
    "consumes an accepted $replyToMode target across $transition fallback",
    async ({ replyToMode, transition }) => {
      const context = createContext();
      let rejected = false;
      http.respondToCall = (call) => {
        const reject =
          transition === "one-page"
            ? call.method === "editMessageText"
            : transition === "retained-page" &&
              call.method === "sendMessage" &&
              call.fields.text === "B".repeat(40);
        if (reject && !rejected) {
          rejected = true;
          return { error_code: 400, description: "Bad Request: final page rejected" };
        }
        return undefined;
      };
      const finalText =
        transition === "retained-page"
          ? "A".repeat(80) + "B".repeat(40)
          : "The complete answer replaces the accepted draft.";
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({
            text: transition === "retained-page" ? "A".repeat(40) : finalText,
          });
          await waitForBotApiCall((call) => call.method === "sendMessage");
        },
        {
          mode: "partial",
          toolProgress: false,
          context,
          replyToMode,
          textLimit: transition === "retained-page" ? 80 : 4096,
          finalReply: {
            text:
              transition === "one-page"
                ? "A different final answer after the preview edit fails."
                : finalText,
            replyToId: String(context.msg.message_id),
            ...(transition === "media" ? { mediaUrl: "https://example.test/report.pdf" } : {}),
          },
          telegramDeps: {
            ...defaultTelegramBotDeps,
            loadWebMedia: async () => ({
              buffer: Buffer.from("accepted report bytes"),
              contentType: "application/pdf",
              kind: undefined,
              fileName: "report.pdf",
            }),
          },
        },
      );
      const sends = acceptedCalls.filter(
        (call) => call.method === "sendMessage" || call.method === "sendDocument",
      );
      expect(sends[0]?.fields.reply_parameters).toMatchObject({
        message_id: context.msg.message_id,
      });
      expect(sends).toHaveLength(2);
      if (replyToMode === "all") {
        expect(sends[1]?.fields.reply_parameters).toMatchObject({
          message_id: context.msg.message_id,
        });
      } else {
        expect(sends[1]?.fields).not.toHaveProperty("reply_parameters");
        expect(sends[1]?.fields).not.toHaveProperty("reply_to_message_id");
      }
      if (transition === "retained-page") {
        expect([...visibleMessages.values()]).toEqual(["A".repeat(80), "B".repeat(40)]);
      } else if (transition === "one-page") {
        expect([...visibleMessages.values()]).toEqual([
          "A different final answer after the preview edit fails.",
        ]);
      } else {
        expect(sends[1]?.method).toBe("sendDocument");
        const document = resolveTelegramTestUpload(sends[1]!.fields, "document");
        expect(await document.text()).toBe("accepted report bytes");
        expect([...visibleMessages.values()]).toEqual([finalText, ""]);
      }
    },
  );

  it.each([false, true])(
    "finalizes a current-message quote in place (quote rejected: %s)",
    async (quoteRejected) => {
      const intro =
        "The complete explanation retains the original delivery context and all literal examples.";
      const fenced = "  [[reply_to_current]]\n  MEDIA:./fenced-example.txt";
      const preview = `${intro}\n\n\`\`\`text\n${fenced}`;
      const text = `${preview}\n\`\`\`\n\n    [[reply_to_current]]\n    MEDIA:./indented-example.txt\n\nDone.`;
      http.rejectNextQuote = quoteRejected;
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({ text: preview, delta: preview });
          await waitForBotApiCall((call) => call.method === "sendMessage");
          await options?.onPartialReply?.({ text, replace: true });
        },
        {
          mode: "partial",
          toolProgress: false,
          replyToMode: "all",
          accountId: "sut",
          finalReply: { text, replyToCurrent: true },
        },
      );
      expect(visibleMessages.size).toBe(1);
      expect([...visibleMessages.values()]).toEqual([
        `${intro}\n\n<pre><code class="language-text">${fenced}\n</code></pre>\n<pre><code>[[reply_to_current]]\nMEDIA:./indented-example.txt\n</code></pre>\nDone.`,
      ]);
      const sends = calls.filter((call) => call.method === "sendMessage");
      expect(sends).toHaveLength(quoteRejected ? 2 : 1);
      expect(sends[0]?.fields.reply_parameters).toMatchObject({
        quote: "Run the failing command.",
        quote_position: 0,
      });
      if (quoteRejected) {
        expect(sends[1]?.fields).toMatchObject({
          reply_to_message_id: expect.any(Number),
          allow_sending_without_reply: true,
        });
        expect(sends[0]?.fields.reply_parameters).toMatchObject({
          message_id: sends[1]?.fields.reply_to_message_id,
        });
        expect(sends[1]?.fields).not.toHaveProperty("reply_parameters");
      }
      const edits = calls.filter((call) => call.method === "editMessageText");
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.every((call) => call.fields.message_id === 1)).toBe(true);
      expect(calls.some((call) => call.method === "deleteMessage")).toBe(false);
    },
  );

  it("replies to the inbound message after a first-mode preview releases its target", async () => {
    const { createTelegramDraftStream } = await import("./draft-stream.js");
    const draftStreams: TelegramDraftStream[] = [];
    const context = createContext();
    const inboundId = context.msg.message_id;
    const preview = "The requested result is ready, and I am completing the final explanation.";
    const finalText = `${preview} Done.`;
    await dispatchProgressTurn(
      async (options) => {
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && String(call.fields.text).includes("Exec"),
        );
        await options?.onAssistantMessageStart?.();
        await options?.onPartialReply?.({ text: preview, delta: preview });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === preview,
        );
        const sends = calls.filter((call) => call.method === "sendMessage");
        expect(sends).toHaveLength(2);
        expect(sends[0]?.fields.reply_parameters).toMatchObject({ message_id: inboundId });
        expect(sends[1]?.fields).not.toHaveProperty("reply_parameters");
        expect(sends[1]?.fields).not.toHaveProperty("reply_to_message_id");
        await expect
          .poll(
            () => draftStreams.find((stream) => stream.messageId() === 2)?.hasConsumedReplyTarget(),
            { timeout: 5_000 },
          )
          .toBe(false);
        expect(
          calls.some((call) => call.method === "deleteMessage" && call.fields.message_id === 1),
        ).toBe(true);
      },
      {
        mode: "partial",
        toolProgress: true,
        replyToMode: "first",
        accountId: "sut",
        context,
        finalReply: { text: finalText, replyToCurrent: true },
        telegramDeps: {
          ...defaultTelegramBotDeps,
          createTelegramDraftStream: (params) => {
            const stream = createTelegramDraftStream(params);
            draftStreams.push(stream);
            return stream;
          },
        },
      },
    );
    await expect.poll(() => [...visibleMessages.values()], { timeout: 5_000 }).toEqual([finalText]);
    const finalSend = calls.find(
      (call) => call.method === "sendMessage" && call.fields.text === finalText,
    );
    expect(
      finalSend?.fields.reply_parameters,
      JSON.stringify({ calls, visibleMessages: [...visibleMessages] }),
    ).toMatchObject({
      message_id: inboundId,
      quote: "Run the failing command.",
      quote_position: 0,
    });
    expect([...visibleMessages.keys()]).toEqual([3]);
  });
  it("retains provider time and General-topic provenance in accepted transcript projections", async () => {
    await withOpenClawTestState({ prefix: "telegram-general-projection-" }, async (state) => {
      const context = createContext();
      const sessionKey = "agent:default:telegram:group:-1001:topic:1";
      const storePath = path.join(state.stateDir, "sessions.json");
      const scope = { agentId: "default", sessionKey, sessionId: "general-projection", storePath };
      const entry = { sessionId: scope.sessionId, updatedAt: Date.now() };
      await patchSessionEntry({ ...scope, fallbackEntry: entry, update: () => entry });
      const chat = {
        id: -1001,
        type: "supergroup",
        title: "Forum",
        is_forum: true,
      } satisfies Message["chat"];
      Object.assign(context, {
        chatId: -1001,
        isGroup: true,
        isForum: true,
        replyThreadId: 1,
        threadSpec: { scope: "forum", id: 1 },
      });
      context.msg = { ...context.msg, chat, message_thread_id: 1, is_topic_message: true };
      Object.assign(context.primaryCtx, {
        me: { id: 123456, is_bot: true, first_name: "Fixture Bot", username: "fixture_bot" },
      });
      context.route.sessionKey = sessionKey;
      Object.assign(context.ctxPayload, {
        SessionKey: sessionKey,
        ChatType: "group",
        From: "telegram:-1001:topic:1",
        To: "telegram:-1001:topic:1",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1001:topic:1",
      });
      let sourceId: string | undefined;
      await dispatchProgressTurn(
        async () => {
          expect(
            sessionDeliveryOrigin(
              getSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
            ),
          ).toMatchObject({
            provider: "telegram",
            to: "telegram:-1001:topic:1",
          });
          sourceId = SessionManager.open(scope, state.stateDir).appendMessage(
            makeAgentAssistantMessage({
              content: [{ type: "text", text: "The General-topic answer." }],
              timestamp: Date.now(),
            }),
          );
        },
        {
          mode: "off",
          toolProgress: false,
          context,
          finalReply: { text: "The General-topic answer." },
          cfg: {
            session: { store: storePath },
            messages: { groupChat: { visibleReplies: "automatic" } },
          },
          telegramCfg: { name: "Configured Agent" },
        },
      );
      expect(acceptedCalls.filter(({ method }) => method === "sendMessage")).toEqual([
        {
          method: "sendMessage",
          fields: expect.objectContaining({ chat_id: "-1001", text: "The General-topic answer." }),
        },
      ]);
      const cache = createTelegramMessageCache({
        scope: resolveTelegramMessageCacheScope(storePath),
      });
      await expect(
        cache.get({ accountId: "default", chatId: -1001, messageId: "1" }),
      ).resolves.toMatchObject({
        body: "The General-topic answer.",
        sender: "Configured Agent (you)",
        senderId: "123456",
        timestamp: 1_700_000_000_000,
        threadBinding: { kind: "provider-observed-v1", threadSpec: { scope: "forum", id: 1 } },
        promptContextProjectionMarker: {
          kind: "valid",
          projection: { transcriptMessageId: sourceId, partIndex: 0, finalPart: true },
        },
      });
      await expect(
        cache.readHistoryWindow({ accountId: "default", chatId: -1001, threadId: 2, limit: 10 }),
      ).resolves.toEqual([]);
      await expect(wasSentByBot("-1001", 1, { session: { store: storePath } })).resolves.toBe(true);
    });
  });

  it("keeps accepted quoted delivery visible when history finalization fails", async () => {
    await withOpenClawTestState({ prefix: "telegram-history-failure-" }, async (state) => {
      const context = createContext();
      const scope = {
        agentId: "default",
        sessionKey: context.route.sessionKey,
        sessionId: "history-failure",
        storePath: path.join(state.stateDir, "sessions.json"),
      };
      const entry = { sessionId: scope.sessionId, updatedAt: Date.now() };
      await patchSessionEntry({ ...scope, fallbackEntry: entry, update: () => entry });
      Object.assign(context.ctxPayload, {
        ReplyToId: "9001",
        ReplyToBody: "quoted slice",
        ReplyToQuoteText: "quoted slice",
        ReplyToIsQuote: true,
      });
      let failed = false;
      await dispatchProgressTurn(
        async () => {
          SessionManager.open(scope, state.stateDir).appendMessage(
            makeAgentAssistantMessage({
              content: [{ type: "text", text: "Accepted quoted answer" }],
              timestamp: Date.now(),
            }),
          );
        },
        {
          mode: "off",
          toolProgress: false,
          context,
          replyToMode: "all",
          cfg: { session: { store: scope.storePath } },
          finalReply: { text: "Accepted quoted answer", replyToId: "9001" },
          allowErrors: true,
          telegramDeps: {
            ...defaultTelegramBotDeps,
            recordOutboundMessageForPromptContext: async (params) => {
              if (params.promptContextProjection?.finalPart) {
                failed = true;
                throw new Error("history finalization unavailable");
              }
              return recordOutboundMessageForPromptContext(params);
            },
          },
        },
      );
      expect(failed).toBe(true);
      expect(acceptedCalls.filter(({ method }) => method === "sendMessage")).toEqual([
        {
          method: "sendMessage",
          fields: expect.objectContaining({
            text: "Accepted quoted answer",
            reply_parameters: expect.objectContaining({ message_id: 9001, quote: "quoted slice" }),
          }),
        },
      ]);
      expect([...visibleMessages.values()]).toEqual(["Accepted quoted answer"]);
    });
  });

  it("keeps native errors silent and untargeted without interpreting ordinary approval prose", async () => {
    const context = createContext();
    context.ctxPayload.CommandSource = "native";
    context.ctxPayload.ReplyToId = "99";
    await dispatchProgressTurn(async () => undefined, {
      mode: "off",
      toolProgress: false,
      context,
      replyToMode: "off",
      telegramCfg: { silentErrorReplies: true },
      finalReply: { text: "Native command failed.", isError: true },
    });
    const error = acceptedCalls.find(({ method }) => method === "sendMessage")!.fields;
    expect(error).toMatchObject({ text: "Native command failed.", disable_notification: true });
    expect(error.reply_parameters).toBeUndefined();
    expect(error.reply_to_message_id).toBeUndefined();
    await dispatchProgressTurn(async () => undefined, {
      mode: "off",
      toolProgress: false,
      telegramCfg: { execApprovals: { enabled: true } },
      finalReply: { text: "For example: /approve command allow-once" },
    });
    expect(acceptedCalls.findLast(({ method }) => method === "sendMessage")!.fields).toMatchObject({
      text: "For example: /approve command allow-once",
    });
    expect([...http.visibleMarkup.values()]).toEqual([]);
  });
  it.each(["success", "error", "cancelled", "superseded"] as const)(
    "restores real status reactions after %s without late stall work",
    async (outcome) => {
      const context = createContext();
      const cancelled = outcome === "cancelled" || outcome === "superseded";
      const queued = createDeferred<void>();
      const reactionErrors: unknown[] = [];
      const controller = createStatusReactionController({
        enabled: true,
        initialEmoji: "👀",
        emojis: { done: "👍", error: "😱" },
        timing: { debounceMs: 0, doneHoldMs: 0, errorHoldMs: 0 },
        adapter: {
          setReaction: async (emoji) => {
            await reactMessageTelegram("123", context.msg.message_id, emoji, {
              api: http.bot.api,
              token: http.token,
              cfg: { channels: { telegram: { botToken: http.token, apiRoot: http.apiRoot } } },
            });
            if (emoji === "👀") {
              queued.resolve();
            }
          },
        },
        onError: (error) => {
          reactionErrors.push(error);
          queued.reject(error);
        },
      });
      context.statusReactionController = controller;
      await controller.setQueued();
      await queued.promise;
      const abort = new AbortController();
      if (outcome === "cancelled") {
        abort.abort(new Error("adoption expired"));
      }
      const held = {
        predicate: (call: { method: string }) => call.method === "setMessageReaction",
        arrived: createDeferred<void>(),
        release: createDeferred<void>(),
      };
      if (outcome === "success") {
        http.holdNextCall = held;
      }
      try {
        const work = dispatchProgressTurn(
          async (options) => {
            if (outcome === "success") {
              const tool = emitToolStart(options, {
                name: "exec",
                toolCallId: "held-status",
                phase: "start",
              });
              try {
                await held.arrived.promise;
                await waitForBotApiCall(
                  (call) =>
                    call.method === "sendMessage" && String(call.fields.text).includes("Exec"),
                );
                expect([...visibleMessages.values()]).toEqual([expect.stringContaining("Exec")]);
              } finally {
                held.release.resolve();
              }
              await tool;
              await waitForBotApiCall(
                (call) =>
                  call.method === "setMessageReaction" &&
                  JSON.stringify(call.fields.reaction).includes("🛠️"),
              );
              await options?.onCompactionStart?.();
              await waitForBotApiCall(
                (call) =>
                  call.method === "setMessageReaction" &&
                  JSON.stringify(call.fields.reaction).includes("\u{1f5dc}\ufe0f"),
              );
              const callsBeforeCompactionEnd = calls.length;
              const acceptedBeforeCompactionEnd = acceptedCalls.length;
              await options?.onCompactionEnd?.({ completed: true });
              await waitForBotApiCall(
                (call) =>
                  calls.indexOf(call) >= callsBeforeCompactionEnd &&
                  call.method === "setMessageReaction" &&
                  JSON.stringify(call.fields.reaction).includes("🧠"),
              );
              expect(acceptedCalls.slice(acceptedBeforeCompactionEnd)).toContainEqual({
                method: "setMessageReaction",
                fields: expect.objectContaining({ reaction: [{ type: "emoji", emoji: "🧠" }] }),
              });
            } else {
              throw new Error("model failed");
            }
          },
          {
            mode: "progress",
            toolProgress: true,
            context,
            finalReply: { text: "Completed." },
            allowErrors: outcome === "error",
            turnAdoptionLifecycle: cancelled
              ? {
                  abortSignal: abort.signal,
                  onAdopted: () => {
                    throw new Error("Cancelled turn was adopted");
                  },
                }
              : undefined,
          },
        );
        if (outcome === "superseded") {
          abort.abort(new Error("authority expired during preparation"));
        }
        await work;
        await vi.advanceTimersByTimeAsync(31_000);
        if (!cancelled) {
          const initialReaction = calls.find(({ method }) => method === "setMessageReaction");
          await waitForBotApiCall(
            (call) =>
              call !== initialReaction &&
              call.method === "setMessageReaction" &&
              JSON.stringify(call.fields.reaction).includes("👀"),
          );
        }
        expect(reactionErrors).toEqual([]);
        const reactions = acceptedCalls
          .filter(({ method }) => method === "setMessageReaction")
          .map(({ fields }) => fields.reaction);
        if (cancelled) {
          expect(reactions).toEqual([[{ type: "emoji", emoji: "👀" }]]);
          expect(calls.filter(({ method }) => method !== "setMessageReaction")).toEqual([]);
        } else {
          expect(reactions.at(-1)).toEqual([{ type: "emoji", emoji: "👀" }]);
          expect([...visibleMessages.values()]).toEqual([
            outcome === "success"
              ? "Completed."
              : "Something went wrong while processing your request. Please try again.",
          ]);
          expect(reactions).toContainEqual([
            { type: "emoji", emoji: outcome === "success" ? "👍" : "😱" },
          ]);
          if (outcome === "success") {
            expect(reactions).toContainEqual([{ type: "emoji", emoji: "\u{1f5dc}\ufe0f" }]);
          }
        }
      } finally {
        held.release.resolve();
        await controller.clear();
      }
    },
  );

  it("keeps participant media roots and mirrored sessions isolated through real group delivery", async () => {
    const state = http.state;
    const store = state.path("{agentId}", "sessions.json");
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        entries: {
          root: { workspace: state.path("root") },
          alice: { workspace: state.path("alice"), identity: { name: "Alice [reviewer]" } },
          bob: { workspace: state.path("bob"), identity: { name: "Bob" } },
        },
      },
      bindings: [{ agentId: "root", match: { channel: "telegram", accountId: "default" } }],
      session: { store, dmScope: "per-channel-peer" as const },
      broadcast: { "telegram:123": ["alice", "bob"] },
    };
    for (const agentId of ["alice", "bob"]) {
      await fs.mkdir(state.path(agentId), { recursive: true });
      await fs.writeFile(state.path(agentId, `${agentId}.txt`), `${agentId} owned bytes`);
      const entry = { sessionId: `session-${agentId}`, updatedAt: Date.now() };
      await patchSessionEntry({
        agentId,
        sessionKey: `agent:${agentId}:telegram:direct:123`,
        storePath: state.path(agentId, "sessions.json"),
        fallbackEntry: entry,
        update: () => entry,
      });
    }
    const context = createContext();
    context.route = {
      ...context.route,
      agentId: "root",
      sessionKey: "agent:root:telegram:direct:123",
      dmScope: "per-channel-peer",
    };
    context.ctxPayload = finalizeInboundContext({
      ...context.ctxPayload,
      AgentId: "root",
      SessionKey: context.route.sessionKey,
      DmScope: "per-channel-peer",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:123",
      NativeChannelId: "123",
      AccountId: "default",
      From: "telegram:123",
      To: "telegram:123",
      ReplyToId: String(context.msg.message_id),
      ReplyToQuoteText: "Review the attachment",
      ReplyToIsQuote: true,
      GroupThread: resolveGroupThreadMentionFacts({
        cfg,
        channel: "telegram",
        peerId: "123",
        text: "Review the attachment",
        sessionKey: context.route.sessionKey,
      }),
    });
    await dispatchProgressTurn(async () => undefined, {
      mode: "off",
      toolProgress: false,
      context,
      cfg,
      replyToMode: "all",
      producer: async ({ ctx, dispatcher }) => {
        const agentId = ctx.AgentId;
        if (agentId !== "alice" && agentId !== "bob") {
          throw new Error(`Unexpected participant ${agentId}`);
        }
        const queuedFinal = dispatcher.sendFinalReply({
          text: `Attachment from ${agentId}`,
          mediaUrl: state.path(agentId, `${agentId}.txt`),
        });
        return { queuedFinal, counts: dispatcher.getQueuedCounts() };
      },
    });
    const documents = acceptedCalls.filter(({ method }) => method === "sendDocument");
    expect(documents).toHaveLength(2);
    const uploaded = await Promise.all(
      documents.map(async ({ fields }) => {
        const file = resolveTelegramTestUpload(fields, "document");
        return [file.name, await file.text()];
      }),
    );
    expect(uploaded.toSorted(([left], [right]) => left!.localeCompare(right!))).toEqual([
      ["alice.txt", "alice owned bytes"],
      ["bob.txt", "bob owned bytes"],
    ]);
    for (const agentId of ["alice", "bob"]) {
      const entries = await readVisibleSessionTranscriptMessageEntries({
        agentId,
        sessionKey: `agent:${agentId}:telegram:direct:123`,
        sessionId: `session-${agentId}`,
        storePath: state.path(agentId, "sessions.json"),
      });
      expect(JSON.stringify(entries)).toContain(`${agentId}.txt`);
      expect(JSON.stringify(entries)).not.toContain(`${agentId === "alice" ? "bob" : "alice"}.txt`);
    }
  });
  it("suppresses late nonterminal diagnostics without hiding a terminal failure", async () => {
    await dispatchProgressTurn(async () => undefined, {
      mode: "off",
      toolProgress: false,
      producer: async ({ dispatcher }) => {
        dispatcher.sendToolResult({ text: "Diagnostic before final", isError: true });
        dispatcher.sendFinalReply({ text: "Accepted answer" });
        dispatcher.sendToolResult({ text: "Hidden late tool" });
        dispatcher.sendFinalReply(
          setReplyPayloadMetadata(
            { text: "Hidden late warning", isError: true },
            { nonTerminalToolErrorWarning: true },
          ),
        );
        const queuedFinal = dispatcher.sendFinalReply({ text: "Terminal failure", isError: true });
        return { queuedFinal, counts: dispatcher.getQueuedCounts() };
      },
    });
    expect([...visibleMessages.values()]).toEqual([
      "Diagnostic before final",
      "Accepted answer",
      "Terminal failure",
    ]);
  });
});
