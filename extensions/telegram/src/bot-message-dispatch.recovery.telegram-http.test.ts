import fs from "node:fs/promises";
import path from "node:path";
import { createAssistant } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { collectReplyMediaEntries } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginHookReplyPayloadSendingEvent } from "openclaw/plugin-sdk/core";
import type { Model } from "openclaw/plugin-sdk/llm";
import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  buildReplyPayloads,
  createReplyToModeFilterForChannel,
  setReplyPayloadMetadata,
} from "openclaw/plugin-sdk/reply-payload-testing";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it } from "vitest";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";
import { resolveTelegramTestUpload } from "./send.telegram-http.test-support.js";

const model: Model<"google-generative-ai"> = {
  id: "gemini-2.5-flash",
  name: "Gemini 2.5 Flash",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const recoveryPrefix = "The complete answer preserves this sufficiently long opening paragraph";
const recoveredAnswer =
  recoveryPrefix + " and continues with all the source-backed details required for this answer.";

describe("Telegram transcript-backed answer recovery through HTTP", () => {
  const http = createTelegramDispatchHttpFixture();
  const { calls, visibleMessages, acceptedCalls, dispatchProgressTurn, waitForBotApiCall } = http;

  async function transcriptCase(sessionId: string) {
    const context = http.createContext();
    const scope = {
      agentId: context.route.agentId,
      sessionId,
      sessionKey: context.route.sessionKey,
      storePath: http.state.path("sessions.json"),
    };
    const workspace = http.state.workspaceDir;
    const entry = { sessionId, updatedAt: Date.now() };
    await patchSessionEntry({ ...scope, fallbackEntry: entry, update: () => entry });
    const manager = SessionManager.open(scope, workspace);
    manager.appendMessage({
      role: "user",
      content: "Answer with the requested files.",
      timestamp: Date.now(),
    });
    const cfg = {
      agents: {
        defaults: { sandbox: { mode: "off" as const } },
        entries: { default: { workspace } },
      },
    };
    return { context, scope, workspace, manager, cfg };
  }

  it.each(["first", "all"] as const)(
    "recovers the latest scoped answer without reopening an accepted %s target",
    async (replyToMode) => {
      const { context, manager } = await transcriptCase("latest-queued-answer");
      const first = "The first queued answer remains visible in the conversation.";
      const { replyPayloads } = await buildReplyPayloads({
        payloads: [
          { text: "[[reply_to_current]]" + first },
          { text: "[[reply_to_current]]" + recoveredAnswer },
        ],
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        applyReplyToMode: createReplyToModeFilterForChannel(replyToMode, "telegram"),
        replyToMode,
        replyToChannel: "telegram",
        currentMessageId: String(context.msg.message_id),
      });
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "shorten-latest-answer",
        hookName: "reply_payload_sending",
        handler: (event: PluginHookReplyPayloadSendingEvent) =>
          event.kind === "final" && event.payload.text === recoveredAnswer
            ? { payload: { ...event.payload, text: recoveryPrefix + "..." } }
            : undefined,
      });
      initializeGlobalHookRunner(registry);
      await dispatchProgressTurn(
        async () => {
          manager.appendMessage(
            createAssistant(model, [{ type: "text", text: "[[reply_to_current]]" + first }]),
          );
          manager.appendMessage({
            role: "user",
            content: "Now answer the queued follow-up.",
            timestamp: Date.now(),
          });
          manager.appendMessage(
            createAssistant(model, [
              { type: "text", text: "[[reply_to_current]]" + recoveredAnswer },
            ]),
          );
          manager.flushPendingPersistence();
        },
        {
          context,
          mode: "off",
          toolProgress: false,
          replyToMode,
          finalReply: replyPayloads,
        },
      );
      const sends = acceptedCalls.filter((call) => call.method === "sendMessage");
      expect(sends.map((call) => call.fields.text)).toEqual([first, recoveredAnswer]);
      expect(
        sends.map(
          (call) =>
            (call.fields.reply_parameters as { message_id?: number } | undefined)?.message_id ??
            call.fields.reply_to_message_id ??
            null,
        ),
      ).toEqual(
        replyToMode === "all"
          ? [context.msg.message_id, context.msg.message_id]
          : [context.msg.message_id, null],
      );
      expect(calls.filter((call) => call.method === "deleteMessage")).toEqual([]);
    },
  );

  it("rejects stale, other-session, and preceding-input transcript recovery", async () => {
    const { context, manager, scope, workspace } = await transcriptCase("stale-answer");
    manager.appendMessage({
      ...createAssistant(model, [{ type: "text", text: recoveredAnswer + "\n[[reply_to:42]]" }]),
      timestamp: Date.now() - 60_000,
    });
    manager.flushPendingPersistence();
    await dispatchProgressTurn(
      async () => {
        const otherScope = {
          ...scope,
          sessionId: "unrelated-answer",
          sessionKey: scope.sessionKey + ":other",
        };
        const entry = { sessionId: otherScope.sessionId, updatedAt: Date.now() };
        await patchSessionEntry({ ...otherScope, fallbackEntry: entry, update: () => entry });
        const other = SessionManager.open(otherScope, workspace);
        other.appendMessage({
          role: "user",
          content: "Different conversation.",
          timestamp: Date.now(),
        });
        other.appendMessage(
          createAssistant(model, [{ type: "text", text: recoveredAnswer + "\n[[reply_to:99]]" }]),
        );
        other.flushPendingPersistence();
      },
      { context, mode: "off", toolProgress: false, finalReply: { text: recoveryPrefix + "..." } },
    );
    const sends = acceptedCalls.filter((call) => call.method === "sendMessage");
    expect(sends.map((call) => call.fields.text)).toEqual([recoveryPrefix + "..."]);
    expect(sends[0]?.fields.reply_parameters).toBeUndefined();
    expect(sends[0]?.fields.reply_to_message_id).toBeUndefined();
    await dispatchProgressTurn(
      async () => {
        const current = SessionManager.open(scope, workspace);
        current.appendMessage(
          createAssistant(model, [{ type: "text", text: recoveredAnswer + "\n[[reply_to:42]]" }]),
        );
        current.flushPendingPersistence();
      },
      {
        mode: "off",
        toolProgress: false,
        finalReply: setReplyPayloadMetadata(
          { text: recoveryPrefix + "..." },
          { precedingInputAnswer: true },
        ),
      },
    );
    expect(
      acceptedCalls.filter((call) => call.method === "sendMessage").map((call) => call.fields.text),
    ).toEqual([recoveryPrefix + "...", recoveryPrefix + "..."]);
  });

  it.each([
    { answer: "preceding text", preceding: true, media: false },
    { answer: "preceding media", preceding: true, media: true },
    { answer: "current text", preceding: false, media: false },
  ] as const)(
    "keeps $answer recovery scoped while a longer answer preview is active",
    async ({ preceding, media }) => {
      const { context, workspace, manager, cfg } = await transcriptCase("active-answer-recovery");
      const earlier = recoveryPrefix + "...";
      const document = path.join(workspace, "earlier-answer.txt");
      if (media) {
        await fs.writeFile(document, "Attachment belonging only to the earlier answer.\n");
      }
      const payload = setReplyPayloadMetadata(
        { text: earlier, ...(media ? { mediaUrl: document } : {}) },
        preceding ? { precedingInputAnswer: true } : {},
      );
      let previewId: number | undefined;
      await dispatchProgressTurn(
        async (options) => {
          manager.appendMessage(createAssistant(model, [{ type: "text", text: earlier }]));
          manager.appendMessage({
            role: "user",
            content: "Continue with the complete latest answer.",
            timestamp: Date.now(),
          });
          manager.appendMessage(createAssistant(model, [{ type: "text", text: recoveredAnswer }]));
          manager.flushPendingPersistence();
          await options?.onPartialReply?.({ text: recoveredAnswer });
          await waitForBotApiCall(
            (call) => call.method === "sendMessage" && call.fields.text === recoveredAnswer,
          );
          previewId = [...visibleMessages.keys()][0];
        },
        {
          context,
          cfg,
          mode: "partial",
          toolProgress: false,
          finalReply: preceding ? [payload, { text: recoveredAnswer }] : payload,
        },
      );
      expect([...visibleMessages.values()].filter(Boolean)).toEqual(
        preceding ? [earlier, recoveredAnswer] : [recoveredAnswer],
      );
      expect(visibleMessages.get(previewId!)).toBe(preceding ? earlier : recoveredAnswer);
      const uploads = acceptedCalls.filter((call) => call.method === "sendDocument");
      expect(
        await Promise.all(
          uploads.map((call) => resolveTelegramTestUpload(call.fields, "document").text()),
        ),
      ).toEqual(media ? ["Attachment belonging only to the earlier answer.\n"] : []);
    },
  );

  it.each(["accepted", "partial", "substitute"] as const)(
    "deduplicates only accepted source aliases after a %s block and recovered final",
    async (selection) => {
      const { context, workspace, manager, cfg } = await transcriptCase("accepted-media-aliases");
      const sources = ["A", "B", "C", "D"].map((name) => path.join(workspace, `${name}.txt`));
      await Promise.all(
        sources.map((source, index) =>
          fs.writeFile(source, `Document ${["A", "B", "C", "D"][index]}\n`),
        ),
      );
      const authored = sources.slice(0, selection === "accepted" ? 1 : 3);
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "select-block-and-shorten-final",
        hookName: "reply_payload_sending",
        handler: (event: PluginHookReplyPayloadSendingEvent) => {
          if (event.kind === "block") {
            if (event.payload.text === recoveredAnswer) {
              return { cancel: true };
            }
            const media = collectReplyMediaEntries(event.payload);
            const selected =
              selection === "partial"
                ? [media[1]!, media[0]!]
                : selection === "accepted"
                  ? media
                  : [{ url: sources[3]!, attachment: { name: "D.txt" } }];
            return {
              payload: {
                ...event.payload,
                mediaUrl: undefined,
                mediaUrls: selected.map(({ url }) => url),
                attachments: selected.map(({ attachment }) => attachment ?? {}),
              },
            };
          }
          return {
            payload: {
              ...event.payload,
              text: recoveryPrefix + "...",
              replyToId: undefined,
              replyToCurrent: undefined,
              replyToTag: undefined,
            },
          };
        },
      });
      initializeGlobalHookRunner(registry);
      let documents = 0;
      http.respondToCall = (call) =>
        call.method === "sendDocument" && ++documents === 2 && selection === "partial"
          ? { error_code: 400, description: "Bad Request: DOCUMENT_INVALID" }
          : undefined;
      await dispatchProgressTurn(
        async (options) => {
          await options?.onBlockReply?.({ text: "Initial documents.", mediaUrls: authored });
          await waitForBotApiCall((call) => call.method === "sendDocument");
          await options?.onBlockReply?.({ text: recoveredAnswer, mediaUrls: authored });
          manager.appendMessage(
            createAssistant(model, [
              {
                type: "text",
                text:
                  recoveredAnswer +
                  authored.map((source) => "\nMEDIA:" + source).join("") +
                  "\n[[reply_to_current]]",
              },
            ]),
          );
          manager.flushPendingPersistence();
        },
        {
          context,
          cfg,
          mode: "off",
          toolProgress: false,
          allowErrors: selection === "partial",
          finalReply: {
            text: recoveredAnswer,
            mediaUrls: authored.slice(0, 2),
            mediaUrl: authored[2],
          },
        },
      );
      const uploads = acceptedCalls
        .filter((call) => call.method === "sendDocument")
        .map((call) => resolveTelegramTestUpload(call.fields, "document"));
      expect(await Promise.all(uploads.map((file) => file.text()))).toEqual(
        selection === "accepted"
          ? ["Document A\n"]
          : selection === "partial"
            ? ["Document B\n", "Document A\n", "Document C\n"]
            : ["Document D\n", "Document A\n", "Document B\n", "Document C\n"],
      );
      expect(uploads.map((file) => file.name)).toEqual(
        selection === "accepted"
          ? ["A.txt"]
          : selection === "partial"
            ? ["B.txt", "A.txt", "C.txt"]
            : ["D.txt", "A.txt", "B.txt", "C.txt"],
      );
      const final = acceptedCalls.filter(
        (call) => (call.fields.caption ?? call.fields.text) === recoveredAnswer,
      );
      expect(final).toHaveLength(1);
      expect(
        Number(
          (final[0]?.fields.reply_parameters as { message_id?: number } | undefined)?.message_id ??
            final[0]?.fields.reply_to_message_id,
        ),
      ).toBe(context.msg.message_id);
      expect([...visibleMessages.values()].filter(Boolean)).toEqual([
        "Initial documents.",
        recoveredAnswer,
      ]);
    },
  );

  it.each([
    { selection: "remove", expected: [] },
    { selection: "reorder", expected: ["Document C\n", "Document A\n"] },
    { selection: "replace-later", expected: ["Document D\n"] },
  ] as const)(
    "keeps $selection hook media selection when recovering transcript text",
    async ({ selection, expected }) => {
      const { context, workspace, manager, cfg } = await transcriptCase("selected-media-recovery");
      const sources = ["A", "B", "C", "D"].map((name) => path.join(workspace, `${name}.txt`));
      await Promise.all(
        sources.map((source, index) =>
          fs.writeFile(source, `Document ${["A", "B", "C", "D"][index]}\n`),
        ),
      );
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "select-final-media",
        hookName: "reply_payload_sending",
        priority: 10,
        handler: (event: PluginHookReplyPayloadSendingEvent) => {
          const media = collectReplyMediaEntries(event.payload);
          const selected = selection === "remove" ? [] : [media[2]!, media[0]!];
          return {
            payload: {
              ...event.payload,
              text: recoveryPrefix + "...",
              mediaUrl: undefined,
              mediaUrls: selected.map(({ url }) => url),
              attachments: selected.map(({ attachment }) => attachment ?? {}),
            },
          };
        },
      });
      addTestHook({
        registry,
        pluginId: "replace-final-media",
        hookName: "reply_payload_sending",
        handler: (event: PluginHookReplyPayloadSendingEvent) =>
          selection === "replace-later"
            ? {
                payload: {
                  ...event.payload,
                  mediaUrl: undefined,
                  mediaUrls: [sources[3]!],
                  attachments: [{ name: "D.txt" }],
                },
              }
            : undefined,
      });
      initializeGlobalHookRunner(registry);
      await dispatchProgressTurn(
        async () => {
          manager.appendMessage(
            createAssistant(model, [
              {
                type: "text",
                text:
                  recoveredAnswer +
                  sources
                    .slice(0, 3)
                    .map((source) => "\nMEDIA:" + source)
                    .join("") +
                  "\n[[reply_to_current]]",
              },
            ]),
          );
          manager.flushPendingPersistence();
        },
        {
          context,
          cfg,
          mode: "off",
          toolProgress: false,
          finalReply: { text: recoveredAnswer, mediaUrls: sources.slice(0, 3) },
        },
      );
      const uploads = acceptedCalls.filter((call) => call.method === "sendDocument");
      expect(
        await Promise.all(
          uploads.map((call) => resolveTelegramTestUpload(call.fields, "document").text()),
        ),
      ).toEqual(expected);
      const messages = acceptedCalls.filter(
        (call) =>
          (call.method === "sendMessage" || call.method === "sendDocument") &&
          (call.fields.text || call.fields.caption),
      );
      expect(messages.map((call) => call.fields.text ?? call.fields.caption)).toEqual([
        recoveredAnswer,
      ]);
      expect(
        Number(
          (messages[0]?.fields.reply_parameters as { message_id?: number } | undefined)
            ?.message_id ?? messages[0]?.fields.reply_to_message_id,
        ),
      ).toBe(context.msg.message_id);
    },
  );
});
