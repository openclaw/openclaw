/**
 * 推推收消息 webhook：校验 X-Tuitui-Robot-Checksum，解析事件并接入 pipeline。
 * 文档：5、机器人收消息 — 收消息回调url、安全身份验证、收消息格式。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createHash } from "node:crypto";
import {
  createReplyPrefixOptions,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk";
import type { ResolvedTuituiAccount } from "./accounts.js";
import { getTuituiRuntime } from "./runtime.js";
import { sendMessageTuitui } from "./send.js";

const TUITUI_WEBHOOK_DEFAULT_PATH = "/tuitui-webhook";
const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const WEBHOOK_BODY_TIMEOUT_MS = 30_000;

export type TuituiWebhookTarget = {
  path: string;
  account: ResolvedTuituiAccount;
  config: OpenClawConfig;
  runtime: { log?: (m: string) => void; error?: (m: string) => void };
  core: ReturnType<typeof getTuituiRuntime>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, TuituiWebhookTarget[]>();

function normalizePath(raw: string): string {
  const t = raw.trim();
  if (!t) return "/";
  const withSlash = t.startsWith("/") ? t : `/${t}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

export function registerTuituiWebhookTarget(target: TuituiWebhookTarget): () => void {
  const path = normalizePath(target.path);
  const entry = { ...target, path };
  const list = webhookTargets.get(path) ?? [];
  webhookTargets.set(path, [...list, entry]);
  return () => {
    const next = (webhookTargets.get(path) ?? []).filter((e) => e !== entry);
    if (next.length > 0) webhookTargets.set(path, next);
    else webhookTargets.delete(path);
  };
}

/** Checksum = sha1(app_secret + timestamp + nonce + post_body_json) */
function verifyTuituiChecksum(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return createHash("sha1")
    .update(secret + timestamp + nonce + body)
    .digest("hex");
}

/** 收消息格式：event + data (msgid, msg_type, text, group_id, at_me 等) */
type TuituiInboundPayload = {
  cid?: string;
  uid?: string;
  user_account?: string;
  user_name?: string;
  timestamp?: string;
  event?: string;
  data?: {
    msgid?: string;
    msg_type?: string;
    text?: string;
    group_id?: string;
    group_name?: string;
    at_me?: boolean;
  };
};

function isSenderAllowed(senderAccount: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  const normalized = senderAccount.toLowerCase();
  return allowFrom.some(
    (e) =>
      String(e)
        .toLowerCase()
        .replace(/^(tuitui|tt):/i, "")
        .trim() === normalized,
  );
}

async function processTuituiInbound(params: {
  payload: TuituiInboundPayload;
  account: ResolvedTuituiAccount;
  config: OpenClawConfig;
  runtime: TuituiWebhookTarget["runtime"];
  core: TuituiWebhookTarget["core"];
  statusSink?: (p: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, config, runtime, core, statusSink } = params;
  const event = payload.event;
  const data = payload.data;
  const userAccount = (payload.user_account ?? "").trim();
  const userName = payload.user_name?.trim();

  if (event === "single_chat_open") {
    statusSink?.({ lastInboundAt: Date.now() });
    return;
  }

  if (event !== "single_chat" && event !== "group_chat") {
    return;
  }

  if (!data?.msgid) return;

  const isGroup = event === "group_chat";
  const groupId = (data.group_id ?? "").trim();
  const chatId = isGroup ? groupId : userAccount;
  const atMe = data.at_me === true;
  let text = (data.text ?? "").trim();
  const msgType = data.msg_type ?? "text";

  if (msgType !== "text" || !text) {
    if (msgType !== "text") {
      runtime.log?.(`[tuitui] 暂不处理非文本: msg_type=${msgType}`);
    }
    return;
  }

  if (isGroup && !atMe) {
    return;
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const allowFrom = (account.config.allowFrom ?? []).map((x) => String(x).trim());
  const storeAllowFrom = await core.channel.pairing.readAllowFromStore("tuitui").catch(() => []);
  const effectiveAllowFrom = [...allowFrom, ...storeAllowFrom];
  const senderAllowed = isSenderAllowed(userAccount, effectiveAllowFrom);
  const rawBody = text;
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: config.commands?.useAccessGroups !== false,
        authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowed }],
      })
    : undefined;

  if (!isGroup) {
    if (dmPolicy === "disabled") return;
    if (dmPolicy !== "open" && !senderAllowed) {
      if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: "tuitui",
          id: userAccount,
          meta: { name: userName ?? undefined },
        });
        if (created) {
          const reply = core.channel.pairing.buildPairingReply({
            channel: "tuitui",
            idLine: `您的域账号: ${userAccount}`,
            code,
          });
          await sendMessageTuitui(userAccount, reply, {
            cfg: config,
            accountId: account.accountId,
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        }
      }
      return;
    }
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "tuitui",
    accountId: account.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: chatId },
  });

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    return;
  }

  const fromLabel = isGroup ? `group:${chatId}` : userName || `user:${userAccount}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const timestampMs = payload.timestamp ? Number(payload.timestamp) * 1000 : undefined;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "推推",
    from: fromLabel,
    timestamp: timestampMs,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `tuitui:group:${chatId}` : `tuitui:${userAccount}`,
    To: `tuitui:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: userName ?? undefined,
    SenderId: userAccount,
    CommandAuthorized: commandAuthorized,
    Provider: "tuitui",
    Surface: "tuitui",
    MessageSid: data.msgid,
    OriginatingChannel: "tuitui",
    OriginatingTo: `tuitui:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => runtime.error?.(`tuitui: session meta: ${String(err)}`),
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "tuitui",
    accountId: account.accountId,
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "tuitui",
    accountId: account.accountId,
  });
  const chunkMode = core.channel.text.resolveChunkMode(config, "tuitui", account.accountId);
  const textChunkLimit = 50000;

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        const outText = core.channel.text.convertMarkdownTables(
          payload.text ?? "",
          tableMode ?? "code",
        );
        const chunks = core.channel.text.chunkMarkdownTextWithMode(
          outText,
          textChunkLimit,
          chunkMode,
        );
        for (const chunk of chunks) {
          try {
            await sendMessageTuitui(chatId, chunk, { cfg: config, accountId: account.accountId });
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            runtime.error?.(`tuitui reply send: ${String(err)}`);
          }
        }
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] tuitui ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: { onModelSelected },
  });
}

export async function handleTuituiWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizePath(url.pathname);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const appid = String(req.headers["x-tuitui-robot-appid"] ?? "").trim();
  const timestamp = String(req.headers["x-tuitui-robot-timestamp"] ?? "").trim();
  const nonce = String(req.headers["x-tuitui-robot-nonce"] ?? "").trim();
  const checksum = String(req.headers["x-tuitui-robot-checksum"] ?? "").trim();

  if (!appid || !timestamp || !nonce || !checksum) {
    res.statusCode = 401;
    res.end("missing tuitui webhook headers");
    return true;
  }

  const target = targets.find((t) => t.account.appId === appid);
  if (!target) {
    res.statusCode = 401;
    res.end("unknown appid");
    return true;
  }

  let rawBody: string;
  try {
    rawBody = await readRequestBodyWithLimit(req, {
      maxBytes: WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: WEBHOOK_BODY_TIMEOUT_MS,
      encoding: "utf-8",
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code: string }).code : null;
    res.statusCode =
      code === "PAYLOAD_TOO_LARGE" ? 413 : code === "REQUEST_BODY_TIMEOUT" ? 408 : 400;
    res.end(
      code === "REQUEST_BODY_TIMEOUT"
        ? requestBodyErrorToText("REQUEST_BODY_TIMEOUT")
        : "bad request",
    );
    return true;
  }

  const expected = verifyTuituiChecksum(target.account.secret, timestamp, nonce, rawBody);
  if (expected !== checksum) {
    res.statusCode = 401;
    res.end("checksum mismatch");
    return true;
  }

  let payload: TuituiInboundPayload;
  try {
    payload = JSON.parse(rawBody) as TuituiInboundPayload;
  } catch {
    res.statusCode = 400;
    res.end("invalid json");
    return true;
  }

  if (!payload || typeof payload !== "object") {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  target.statusSink?.({ lastInboundAt: Date.now() });
  processTuituiInbound({
    payload,
    account: target.account,
    config: target.config,
    runtime: target.runtime,
    core: target.core,
    statusSink: target.statusSink,
  }).catch((err) => {
    target.runtime.error?.(`[${target.account.accountId}] tuitui webhook: ${String(err)}`);
  });

  res.statusCode = 200;
  res.end("ok");
  return true;
}

export function getTuituiWebhookDefaultPath(): string {
  return TUITUI_WEBHOOK_DEFAULT_PATH;
}
