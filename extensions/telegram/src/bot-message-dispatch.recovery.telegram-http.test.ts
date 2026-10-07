import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { collectReplyMediaEntries } from "openclaw/plugin-sdk/channel-outbound";
import type {
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
} from "openclaw/plugin-sdk/core";
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
import { makeAgentAssistantMessage, makeAgentUserMessage } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";
import { resolveTelegramTestUpload } from "./send.telegram-http.test-support.js";

const recoveryPrefix = "The complete answer preserves this sufficiently long opening paragraph";
const recoveredAnswer =
  recoveryPrefix + " and continues with all the source-backed details required for this answer.";
const shortened = recoveryPrefix + "...";
const assistant = (text: string, timestamp = Date.now()) =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp });
const user = (content: string) => makeAgentUserMessage({ content, timestamp: Date.now() });

function installHook(
  handler: (
    event: PluginHookReplyPayloadSendingEvent,
  ) => PluginHookReplyPayloadSendingResult | undefined,
) {
  const registry = createEmptyPluginRegistry();
  addTestHook({ registry, pluginId: "recovery", hookName: "reply_payload_sending", handler });
  initializeGlobalHookRunner(registry);
}

describe("Telegram transcript-backed answer recovery through HTTP", () => {
  const http = createTelegramDispatchHttpFixture();
  const { calls, visibleMessages, acceptedCalls, dispatchProgressTurn, waitForBotApiCall } = http;
  const sends = () => acceptedCalls.filter((call) => call.method === "sendMessage");
  const uploads = () =>
    acceptedCalls
      .filter((call) => call.method === "sendDocument")
      .map((call) => resolveTelegramTestUpload(call.fields, "document"));
  const replyId = (fields: Record<string, unknown>) =>
    (fields.reply_parameters as { message_id?: number } | undefined)?.message_id ??
    fields.reply_to_message_id ??
    null;

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
    manager.appendMessage(user("Answer with the requested files."));
    const cfg = {
      agents: {
        defaults: { sandbox: { mode: "off" as const } },
        entries: { default: { workspace } },
      },
    };
    return { context, scope, workspace, manager, cfg };
  }

  it("recovers the latest scoped answer without reopening an accepted first target", async () => {
    const { context, manager } = await transcriptCase("latest-queued-answer");
    const first = "The first queued answer remains visible in the conversation.";
    const { replyPayloads } = await buildReplyPayloads({
      payloads: [first, recoveredAnswer].map((text) => ({ text: "[[reply_to_current]]" + text })),
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      applyReplyToMode: createReplyToModeFilterForChannel("first", "telegram"),
      replyToMode: "first",
      replyToChannel: "telegram",
      currentMessageId: String(context.msg.message_id),
    });
    installHook((event) =>
      event.kind === "final" && event.payload.text === recoveredAnswer
        ? { payload: { ...event.payload, text: shortened } }
        : undefined,
    );
    await dispatchProgressTurn(
      async () => {
        manager.appendMessage(assistant("[[reply_to_current]]" + first));
        manager.appendMessage(user("Now answer the queued follow-up."));
        manager.appendMessage(assistant("[[reply_to_current]]" + recoveredAnswer));
        manager.flushPendingPersistence();
      },
      {
        context,
        mode: "off",
        toolProgress: false,
        replyToMode: "first",
        finalReply: replyPayloads,
      },
    );
    expect(sends().map((call) => call.fields.text)).toEqual([first, recoveredAnswer]);
    expect(sends().map((call) => replyId(call.fields))).toEqual([context.msg.message_id, null]);
    expect(calls.filter((call) => call.method === "deleteMessage")).toEqual([]);
  });

  it("rejects stale and other-session transcript recovery", async () => {
    const { context, manager, scope, workspace } = await transcriptCase("stale-answer");
    manager.appendMessage(assistant(recoveredAnswer + "\n[[reply_to:42]]", Date.now() - 60_000));
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
        other.appendMessage(user("Different conversation."));
        other.appendMessage(assistant(recoveredAnswer + "\n[[reply_to:99]]"));
        other.flushPendingPersistence();
      },
      { context, mode: "off", toolProgress: false, finalReply: { text: shortened } },
    );
    expect(sends().map((call) => call.fields.text)).toEqual([shortened]);
    expect(sends()[0]?.fields.reply_parameters).toBeUndefined();
    expect(sends()[0]?.fields.reply_to_message_id).toBeUndefined();
  });

  it("keeps preceding media scoped while a longer answer preview is active", async () => {
    const { context, workspace, manager, cfg } = await transcriptCase("active-answer-recovery");
    const document = path.join(workspace, "earlier-answer.txt");
    await fs.writeFile(document, "Attachment belonging only to the earlier answer.\n");
    const payload = setReplyPayloadMetadata(
      { text: shortened, mediaUrl: document },
      { precedingInputAnswer: true },
    );
    let previewId: number | undefined;
    await dispatchProgressTurn(
      async (options) => {
        manager.appendMessage(assistant(shortened));
        manager.appendMessage(user("Continue with the complete latest answer."));
        manager.appendMessage(assistant(recoveredAnswer));
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
        finalReply: [payload, { text: recoveredAnswer }],
      },
    );
    expect([...visibleMessages.values()].filter(Boolean)).toEqual([shortened, recoveredAnswer]);
    expect(visibleMessages.get(previewId!)).toBe(shortened);
    expect(await Promise.all(uploads().map((file) => file.text()))).toEqual([
      "Attachment belonging only to the earlier answer.\n",
    ]);
  });

  it("deduplicates only accepted source aliases after a partial block and recovered final", async () => {
    const { context, workspace, manager, cfg } = await transcriptCase("accepted-media-aliases");
    const sources = ["A", "B", "C"].map((name) => path.join(workspace, `${name}.txt`));
    await Promise.all(
      sources.map((source, index) => fs.writeFile(source, `Document ${["A", "B", "C"][index]}\n`)),
    );
    installHook((event) => {
      if (event.kind === "block") {
        if (event.payload.text === recoveredAnswer) {
          return { cancel: true };
        }
        const media = collectReplyMediaEntries(event.payload);
        const selected = [media[1]!, media[0]!];
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
          text: shortened,
          replyToId: undefined,
          replyToCurrent: undefined,
          replyToTag: undefined,
        },
      };
    });
    let documents = 0;
    http.respondToCall = (call) =>
      call.method === "sendDocument" && ++documents === 2
        ? { error_code: 400, description: "Bad Request: DOCUMENT_INVALID" }
        : undefined;
    await dispatchProgressTurn(
      async (options) => {
        await options?.onBlockReply?.({ text: "Initial documents.", mediaUrls: sources });
        await waitForBotApiCall((call) => call.method === "sendDocument");
        await options?.onBlockReply?.({ text: recoveredAnswer, mediaUrls: sources });
        manager.appendMessage(
          assistant(
            recoveredAnswer +
              sources.map((source) => "\nMEDIA:" + source).join("") +
              "\n[[reply_to_current]]",
          ),
        );
        manager.flushPendingPersistence();
      },
      {
        context,
        cfg,
        mode: "off",
        toolProgress: false,
        allowErrors: true,
        finalReply: { text: recoveredAnswer, mediaUrls: sources.slice(0, 2), mediaUrl: sources[2] },
      },
    );
    expect(await Promise.all(uploads().map((file) => file.text()))).toEqual([
      "Document B\n",
      "Document A\n",
      "Document C\n",
    ]);
    expect(uploads().map((file) => file.name)).toEqual(["B.txt", "A.txt", "C.txt"]);
    const final = acceptedCalls.filter(
      (call) => (call.fields.caption ?? call.fields.text) === recoveredAnswer,
    );
    expect(final).toHaveLength(1);
    expect(Number(replyId(final[0]!.fields))).toBe(context.msg.message_id);
    expect([...visibleMessages.values()].filter(Boolean)).toEqual([
      "Initial documents.",
      recoveredAnswer,
    ]);
  });
});
