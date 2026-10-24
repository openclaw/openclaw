import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { collectReplyMediaEntries } from "openclaw/plugin-sdk/channel-outbound";
import type {
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
} from "openclaw/plugin-sdk/core";
import {
  buildReplyPayloads,
  createReplyToModeFilterForChannel,
  setReplyPayloadMetadata,
} from "openclaw/plugin-sdk/reply-payload-testing";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { makeAgentAssistantMessage, makeAgentUserMessage } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  createTelegramDispatchHttpFixture,
  installTelegramDispatchHook,
  telegramReplyId,
} from "./bot-message-dispatch.telegram-http.test-support.js";
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
  installTelegramDispatchHook({ hookName: "reply_payload_sending", handler }, "recovery");
}

describe("Telegram transcript-backed answer recovery through HTTP", () => {
  const http = createTelegramDispatchHttpFixture();
  const { visibleMessages, acceptedCalls, dispatchProgressTurn } = http;
  const sends = () => http.acceptedFor("sendMessage");
  const uploads = () =>
    http
      .acceptedFor("sendDocument")
      .map((call) => resolveTelegramTestUpload(call.fields, "document"));
  const replyId = (fields: Record<string, unknown>) => telegramReplyId(fields) ?? null;

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
    const dispatch = (
      emit: Parameters<typeof dispatchProgressTurn>[0],
      options: Partial<NonNullable<Parameters<typeof dispatchProgressTurn>[1]>> = {},
    ) =>
      dispatchProgressTurn(emit, {
        context,
        mode: "off",
        toolProgress: false,
        finalReply: { text: recoveredAnswer },
        ...options,
      });
    return { context, scope, workspace, manager, cfg, dispatch };
  }

  it.each([
    { name: "retries a transcript-correlated final", controls: undefined },
    {
      name: "does not replay Telegram controls",
      controls: {
        telegram: { buttons: [[{ text: "Continue", callback_data: "continue" }]] },
      },
    },
    { name: "does not replay other channel controls", controls: { other: { action: "send" } } },
  ])("$name without rerunning the model", async ({ controls }) => {
    const { manager, dispatch } = await transcriptCase("ambiguous-transcript-final");
    let modelRuns = 0,
      preparations = 0,
      attempts = 0;
    installHook(({ kind, payload }) => {
      if (kind !== "final") {
        return undefined;
      }
      preparations += 1;
      const channelData = payload.channelData;
      const telegram = channelData?.telegram;
      if (controls) {
        return {
          payload: {
            ...payload,
            channelData: {
              ...channelData,
              ...controls,
              telegram: { ...(isRecord(telegram) ? telegram : {}), ...controls.telegram },
            },
          },
        };
      }
      expect(telegram).toEqual({
        promptContextSource: {
          transcriptMessageId: expect.any(String),
          deliverySignature: expect.any(String),
        },
      });
      return undefined;
    });
    http.respondToCall = (call) => {
      if (call.method !== "sendMessage" || call.fields.text !== recoveredAnswer) {
        return;
      }
      attempts += 1;
      if (controls || attempts === 1) {
        throw Object.assign(new Error("socket closed after request"), { code: "ECONNRESET" });
      }
    };
    await dispatch(
      async () => {
        modelRuns += 1;
        manager.appendMessage(assistant(recoveredAnswer));
        manager.flushPendingPersistence();
      },
      {
        allowErrors: Boolean(controls),
      },
    );
    expect(modelRuns).toBe(1);
    if (controls) {
      expect(attempts).toBe(1);
      expect(sends().some((call) => call.fields.text === recoveredAnswer)).toBe(false);
    } else {
      expect(preparations).toBe(1);
      expect(http.callsFor("sendMessage").map((call) => call.fields.text)).toEqual([
        recoveredAnswer,
        recoveredAnswer,
      ]);
      expect(sends().map((call) => call.fields.text)).toEqual([recoveredAnswer]);
      expect(http.texts()).toEqual([recoveredAnswer]);
    }
  });

  it("recovers the latest scoped answer without reopening an accepted first target", async () => {
    const { context, manager, dispatch } = await transcriptCase("latest-queued-answer");
    const first = "The first queued answer remains visible in the conversation.";
    const { replyPayloads } = await buildReplyPayloads({
      payloads: [first, recoveredAnswer].map((text) => ({ text: "[[reply_to_current]]" + text })),
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      applyReplyToMode: createReplyToModeFilterForChannel("first", "telegram"),
      replyToMode: "first",
      replyToChannel: "telegram",
      currentMessageId: String(context.msg.message_id),
    });
    installHook(({ kind, payload }) =>
      kind === "final" && payload.text === recoveredAnswer
        ? { payload: { ...payload, text: shortened } }
        : undefined,
    );
    await dispatch(
      async () => {
        manager.appendMessage(assistant("[[reply_to_current]]" + first));
        manager.appendMessage(user("Now answer the queued follow-up."));
        manager.appendMessage(assistant("[[reply_to_current]]" + recoveredAnswer));
        manager.flushPendingPersistence();
      },
      { replyToMode: "first", finalReply: replyPayloads },
    );
    expect(sends().map((call) => call.fields.text)).toEqual([first, recoveredAnswer]);
    expect(sends().map((call) => replyId(call.fields))).toEqual([context.msg.message_id, null]);
    expect(http.callsFor("deleteMessage")).toEqual([]);
  });

  it("rejects stale and other-session transcript recovery", async () => {
    const { manager, scope, workspace, dispatch } = await transcriptCase("stale-answer");
    manager.appendMessage(assistant(recoveredAnswer + "\n[[reply_to:42]]", Date.now() - 60_000));
    manager.flushPendingPersistence();
    await dispatch(
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
      { finalReply: { text: shortened } },
    );
    expect(sends().map((call) => call.fields.text)).toEqual([shortened]);
    expect(sends()[0]?.fields.reply_parameters).toBeUndefined();
    expect(sends()[0]?.fields.reply_to_message_id).toBeUndefined();
  });

  it("keeps preceding media scoped while a longer answer preview is active", async () => {
    const { workspace, manager, cfg, dispatch } = await transcriptCase("active-answer-recovery");
    const document = path.join(workspace, "earlier-answer.txt");
    await fs.writeFile(document, "Attachment belonging only to the earlier answer.\n");
    const payload = setReplyPayloadMetadata(
      { text: shortened, mediaUrl: document },
      { precedingInputAnswer: true },
    );
    let previewId: number | undefined;
    await dispatch(
      async (options) => {
        manager.appendMessage(assistant(shortened));
        manager.appendMessage(user("Continue with the complete latest answer."));
        manager.appendMessage(assistant(recoveredAnswer));
        manager.flushPendingPersistence();
        await options?.onPartialReply?.({ text: recoveredAnswer });
        await http.waitForText(recoveredAnswer, "sendMessage");
        previewId = [...visibleMessages.keys()][0];
      },
      {
        cfg,
        mode: "partial",
        finalReply: [payload, { text: recoveredAnswer }],
      },
    );
    expect(http.texts().filter(Boolean)).toEqual([shortened, recoveredAnswer]);
    expect(visibleMessages.get(previewId!)).toBe(shortened);
    expect(await Promise.all(uploads().map((file) => file.text()))).toEqual([
      "Attachment belonging only to the earlier answer.\n",
    ]);
  });

  it("deduplicates only accepted source aliases after a partial block and recovered final", async () => {
    const { context, workspace, manager, cfg, dispatch } =
      await transcriptCase("accepted-media-aliases");
    const sources = ["A", "B", "C"].map((name) => path.join(workspace, `${name}.txt`));
    await Promise.all(
      sources.map((source, index) => fs.writeFile(source, `Document ${["A", "B", "C"][index]}\n`)),
    );
    installHook(({ kind, payload }) => {
      if (kind === "block") {
        if (payload.text === recoveredAnswer) {
          return { cancel: true };
        }
        const media = collectReplyMediaEntries(payload);
        const selected = [media[1]!, media[0]!];
        return {
          payload: {
            ...payload,
            mediaUrl: undefined,
            mediaUrls: selected.map(({ url }) => url),
            attachments: selected.map(({ attachment }) => attachment ?? {}),
          },
        };
      }
      return {
        payload: {
          ...payload,
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
    await dispatch(
      async (options) => {
        await options?.onBlockReply?.({ text: "Initial documents.", mediaUrls: sources });
        await http.waitForMethod("sendDocument");
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
        cfg,
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
    expect(http.texts().filter(Boolean)).toEqual(["Initial documents.", recoveredAnswer]);
  });
});
