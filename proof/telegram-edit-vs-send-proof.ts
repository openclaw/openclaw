#!/usr/bin/env -S node --import tsx
// Real-behavior proof harness for the Telegram in-flight-preamble edit-vs-send fix.
//
// Drives the REAL dispatchTelegramMessage + REAL createTelegramDraftStream (the
// code the bug/fix live in) and replays a realistic assistant-stream event
// sequence: short preamble -> tool_use (no rendered progress, no fresh
// assistant-message boundary) -> post-tool answer text.
//
// Transport: a logging Telegram api. With TG_BOT_TOKEN set it hits the LIVE Bot
// API (api.telegram.org); without a token it records calls only (offline wiring
// check). Every outbound call (method + message_id + text) is written to
// proof/out/<label>.log.
//
// Usage:
//   TG_BOT_TOKEN=... TG_CHAT_ID=... node --import tsx proof/telegram-edit-vs-send-proof.ts <label>
// TG_CHAT_ID is MANDATORY for live runs (TG_BOT_TOKEN set): the harness fails fast
// if it is unset and sends nothing. There is no getUpdates auto-discovery — that
// could target the wrong chat on a reused bot with stale updates.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Bot } from "grammy";
import type { TelegramBotDeps } from "../extensions/telegram/src/bot-deps.js";
import { dispatchTelegramMessage } from "../extensions/telegram/src/bot-message-dispatch.js";
import { createTelegramDraftStream } from "../extensions/telegram/src/draft-stream.js";
import { buildTelegramRichMarkdown } from "../extensions/telegram/src/rich-message.js";
import { setTelegramRuntime } from "../extensions/telegram/src/runtime.js";

// PREAMBLE_TEXT can override the preamble — e.g. a string shorter than the ~30
// char preview debounce (minInitialChars) to exercise the never-sent case, which
// must NOT produce a spurious standalone message at the tool boundary.
const PREAMBLE = process.env.PREAMBLE_TEXT ?? "Let me check the current state of that file.";
const POST_TOOL = "Done — the stale version was already removed earlier.";

const label = process.argv[2] ?? "run";
const token = process.env.TG_BOT_TOKEN;
const chatIdEnv = process.env.TG_CHAT_ID;
const live = Boolean(token);
// Delay between the preamble partial and the tool boundary. 0 = fast (tool fires
// while the preamble send is still in flight — the race). ~2500 = delayed (the
// preamble send acks first). Default fast, since that is the failing case.
const toolDelayMs = Number(process.env.TOOL_DELAY_MS ?? 0);

// Never let the token or chat id reach stdout/stderr (fetch errors can embed the
// URL; the chat id is private).
function scrub(s: string): string {
  let out = token ? s.split(token).join("<redacted-token>") : s;
  if (chatIdEnv) {
    out = out.split(chatIdEnv).join("<redacted-chat>");
  }
  return out;
}

type ApiCall = { method: string; message_id?: number; text?: string };
const calls: ApiCall[] = [];
let nextOfflineId = 1000;

async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  if (!live) {
    return { ok: true, result: { message_id: nextOfflineId++ } };
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: any; description?: string };
  if (!json.ok) {
    throw new Error(`Telegram ${method} failed: ${json.description}`);
  }
  return json;
}

function richText(rich: { markdown?: string; html?: string }): string {
  return "html" in rich && rich.html != null ? rich.html : (rich.markdown ?? "");
}

function createLoggingApi(chatId: string): Bot["api"] {
  return {
    raw: {
      sendRichMessage: async (p: any) => {
        const text = richText(p.rich_message);
        const r = await tg("sendMessage", {
          chat_id: chatId,
          text,
          ...(p.message_thread_id ? { message_thread_id: p.message_thread_id } : {}),
        });
        const id = Number(r.result.message_id);
        calls.push({ method: "sendMessage", message_id: id, text });
        return { message_id: id };
      },
      editMessageText: async (p: any) => {
        const text = richText(p.rich_message);
        if (live) {
          await tg("editMessageText", { chat_id: chatId, message_id: p.message_id, text });
        }
        calls.push({ method: "editMessageText", message_id: Number(p.message_id), text });
        return true;
      },
    },
    sendMessage: async (_chatId: unknown, text: string, p: any) => {
      const r = await tg("sendMessage", { chat_id: chatId, text });
      const id = Number(r.result.message_id);
      calls.push({ method: "sendMessage", message_id: id, text });
      return { message_id: id };
    },
    editMessageText: async (_chatId: unknown, messageId: number, text: string) => {
      if (live) await tg("editMessageText", { chat_id: chatId, message_id: messageId, text });
      calls.push({ method: "editMessageText", message_id: Number(messageId), text });
      return true;
    },
    deleteMessage: async (_chatId: unknown, messageId: number) => {
      if (live) await tg("deleteMessage", { chat_id: chatId, message_id: messageId });
      calls.push({ method: "deleteMessage", message_id: Number(messageId) });
      return true;
    },
    sendChatAction: async () => {
      calls.push({ method: "sendChatAction" });
      return true;
    },
    setMessageReaction: async () => {
      calls.push({ method: "setMessageReaction" });
      return true;
    },
  } as unknown as Bot["api"];
}

// Replay the bug-triggering assistant event sequence into the real dispatch pipeline.
const replayDispatcher = (async ({ dispatcherOptions, replyOptions }: any) => {
  await replyOptions?.onAssistantMessageStart?.();
  await replyOptions?.onPartialReply?.({ text: PREAMBLE });
  // Fast timing (toolDelayMs=0): the tool fires while the preamble send is still
  // in flight. Delayed timing: wait so the preamble send acks first.
  if (toolDelayMs > 0) {
    await sleep(toolDelayMs);
  }
  await replyOptions?.onToolStart?.({ name: "read_file", phase: "start" });
  // No second onAssistantMessageStart: the runtime resumes the same lane.
  await replyOptions?.onPartialReply?.({ text: POST_TOOL, replace: true });
  await dispatcherOptions.deliver({ text: POST_TOOL }, { kind: "final" });
  return { queuedFinal: true };
}) as unknown as TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"];

const noop = async () => undefined;

const telegramDeps = {
  getRuntimeConfig: (() => ({})) as TelegramBotDeps["getRuntimeConfig"],
  resolveStorePath: (() =>
    "/tmp/openclaw-proof-sessions.json") as TelegramBotDeps["resolveStorePath"],
  loadSessionStore: (() => ({})) as TelegramBotDeps["loadSessionStore"],
  readChannelAllowFromStore: (async () => []) as TelegramBotDeps["readChannelAllowFromStore"],
  upsertChannelPairingRequest: (async () => ({
    code: "PROOF",
    created: true,
  })) as unknown as TelegramBotDeps["upsertChannelPairingRequest"],
  enqueueSystemEvent: noop as unknown as TelegramBotDeps["enqueueSystemEvent"],
  dispatchReplyWithBufferedBlockDispatcher: replayDispatcher,
  buildModelsProviderData: (async () => ({
    byProvider: new Map(),
    providers: [],
    resolvedDefault: { provider: "openai", model: "gpt-test" },
    modelNames: new Map(),
  })) as unknown as TelegramBotDeps["buildModelsProviderData"],
  listSkillCommandsForAgents:
    (() => []) as unknown as TelegramBotDeps["listSkillCommandsForAgents"],
  wasSentByBot: (() => false) as TelegramBotDeps["wasSentByBot"],
  createTelegramDraftStream,
  createChannelMessageReplyPipeline: (() => ({
    responsePrefix: undefined,
    responsePrefixContextProvider: () => ({ identityName: undefined }),
    onModelSelected: () => undefined,
  })) as unknown as TelegramBotDeps["createChannelMessageReplyPipeline"],
  deliverReplies: (async () => ({
    delivered: true,
  })) as unknown as TelegramBotDeps["deliverReplies"],
  deliverInboundReplyWithMessageSendContext: (async () => ({
    status: "unsupported",
    reason: "missing_outbound_handler",
  })) as unknown as TelegramBotDeps["deliverInboundReplyWithMessageSendContext"],
  emitInternalMessageSentHook: noop as unknown as TelegramBotDeps["emitInternalMessageSentHook"],
  editMessageTelegram: (async () => ({
    ok: true,
  })) as unknown as TelegramBotDeps["editMessageTelegram"],
  recordOutboundMessageForPromptContext:
    noop as unknown as TelegramBotDeps["recordOutboundMessageForPromptContext"],
} as TelegramBotDeps;

function createContext(chatId: number) {
  const base: any = {
    ctxPayload: { SessionKey: "agent:proof:telegram:direct:" + chatId, ChatType: "direct" },
    primaryCtx: { message: { chat: { id: chatId, type: "private" } } },
    msg: { chat: { id: chatId, type: "private" }, message_id: 1 },
    chatId,
    isGroup: false,
    groupConfig: undefined,
    resolvedThreadId: undefined,
    replyThreadId: undefined,
    threadSpec: { id: undefined, scope: "none" },
    historyKey: undefined,
    historyLimit: 0,
    groupHistories: new Map(),
    route: {
      agentId: "default",
      accountId: "default",
      sessionKey: "agent:proof:telegram:direct:" + chatId,
    },
    skillFilter: undefined,
    sendTyping: async () => undefined,
    sendRecordVoice: async () => undefined,
    sendChatActionHandler: { sendChatAction: async () => undefined },
    ackReactionPromise: null,
    reactionApi: null,
    removeAckAfterReply: false,
  };
  base.turn = {
    storePath: "/tmp/openclaw-proof-sessions.json",
    recordInboundSession: async () => undefined,
    record: { onRecordError: () => undefined },
  };
  return base;
}

function resolveChatId(): string {
  // Offline/no-op (no token): dummy id; nothing is ever sent.
  if (!live) {
    return "999999";
  }
  // Live: require an explicit chat id. No getUpdates auto-discovery — a reused bot
  // with stale updates could otherwise send proof text to the wrong private chat.
  if (!chatIdEnv) {
    console.error(
      "[proof] FATAL: TG_CHAT_ID is required for live sends. Refusing to send (no getUpdates auto-discovery). Set TG_CHAT_ID and retry.",
    );
    process.exit(2);
  }
  return chatIdEnv;
}

async function main() {
  // Opt-in only: this harness performs live Telegram sends and must never run as
  // part of any automated/default flow. Without an explicit token it no-ops.
  if (!live) {
    console.log(
      "[proof] no-op: opt-in live harness. Set TG_BOT_TOKEN (and TG_CHAT_ID) and invoke explicitly. Nothing was sent or executed.",
    );
    return;
  }

  // Minimal in-memory telegram runtime state (no SQLite/files).
  const mem = new Map<string, unknown>();
  const store = {
    get: async (k: string) => mem.get(k),
    set: async (k: string, v: unknown) => void mem.set(k, v),
    delete: async (k: string) => void mem.delete(k),
    list: async () => [...mem.keys()],
    close: async () => undefined,
  };
  setTelegramRuntime({
    state: {
      openKeyedStore: () => store,
      openSyncKeyedStore: () => ({
        get: (k: string) => mem.get(k),
        set: (k: string, v: unknown) => void mem.set(k, v),
        delete: (k: string) => void mem.delete(k),
        list: () => [...mem.keys()],
        close: () => undefined,
      }),
    },
    channel: {},
  } as any);

  const chatId = resolveChatId();
  const numericChatId = Number(chatId) || 999999;
  const api = createLoggingApi(chatId);
  const bot = { api } as unknown as Bot;

  console.log(
    `[proof] label=${label} live=${live} chatId=<redacted-chat> toolDelayMs=${toolDelayMs}`,
  );
  console.log(`[proof] preamble=${JSON.stringify(PREAMBLE)}`);
  console.log(`[proof] postTool=${JSON.stringify(POST_TOOL)}`);

  await dispatchTelegramMessage({
    context: createContext(numericChatId),
    bot,
    cfg: {} as any,
    runtime: {
      log: () => undefined,
      error: () => undefined,
      exit: () => {
        throw new Error("exit");
      },
    } as any,
    replyToMode: "off",
    streamMode: "partial",
    textLimit: 4096,
    telegramCfg: {} as any,
    telegramDeps,
    opts: { token: token ?? "offline" },
  } as any);

  // Let any trailing in-flight Bot API sends settle before reading the log.
  await sleep(live ? 1500 : 50);

  const sends = calls.filter((c) => c.method === "sendMessage");
  const edits = calls.filter((c) => c.method === "editMessageText");
  const preambleSend = sends.find((c) => c.text === PREAMBLE);
  // The bug is the preamble's own message being edited to different text.
  const preambleOverwritten =
    preambleSend != null &&
    edits.some((e) => e.message_id === preambleSend.message_id && e.text !== PREAMBLE);
  const preamblePreserved = preambleSend != null && !preambleOverwritten;
  const summary = {
    label,
    live,
    sends: sends.length,
    edits: edits.length,
    preamblePreserved,
    calls,
  };

  const outDir = join(dirname(fileURLToPath(import.meta.url)), "out");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${label}.log`);
  const lines = [
    `# Telegram edit-vs-send proof: ${label} (live=${live}, toolDelayMs=${toolDelayMs})`,
    `# preamble: ${PREAMBLE}`,
    `# postTool: ${POST_TOOL}`,
    ...calls.map(
      (c, i) =>
        `${i + 1}\t${c.method}\tmessage_id=${c.message_id ?? "-"}\ttext=${JSON.stringify(c.text ?? "")}`,
    ),
    ``,
    `SUMMARY sends=${sends.length} edits=${edits.length} preamblePreserved=${summary.preamblePreserved}`,
  ];
  writeFileSync(outFile, lines.join("\n") + "\n");
  console.log(`[proof] wrote ${outFile}`);
  console.log(
    `[proof] SUMMARY sends=${sends.length} edits=${edits.length} preamblePreserved=${summary.preamblePreserved}`,
  );
}

main().catch((err) => {
  console.error("[proof] FAILED:", scrub(String(err?.stack ?? err)));
  process.exit(1);
});
