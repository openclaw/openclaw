/**
 * DingTalk robot inbound: verify sign, parse body, dispatch to agent.
 * @see https://open.dingtalk.com/document/dingstart/receive-message
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk";
import { sendViaSessionWebhook } from "./client.js";
import {
  verifyDingTalkSign,
  authorizeUserForDm,
  getRateLimiter,
  checkRateLimit,
  sanitizeInput,
} from "./security.js";
import type { ResolvedDingTalkAccount } from "./types.js";
import type { DingTalkInboundPayload } from "./types.js";

const CHANNEL_ID = "dingtalk";

async function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; body: string } | { ok: false; statusCode: number; error: string }> {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: 1_048_576,
      timeoutMs: 30_000,
    });
    return { ok: true, body };
  } catch (err) {
    if (isRequestBodyLimitError(err)) {
      return {
        ok: false,
        statusCode: err.statusCode,
        error: requestBodyErrorToText(err.code),
      };
    }
    return { ok: false, statusCode: 400, error: "Invalid request body" };
  }
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0]?.trim() : String(v).trim();
}

function parsePayload(body: string): DingTalkInboundPayload | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as DingTalkInboundPayload;
  } catch {
    return null;
  }
}

function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export interface DingTalkWebhookHandlerDeps {
  account: ResolvedDingTalkAccount;
  runtime: PluginRuntime;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

export function createDingTalkWebhookHandler(deps: DingTalkWebhookHandlerDeps) {
  const { account, runtime: rt, log } = deps;
  const rateLimiter = getRateLimiter(account.accountId, account.rateLimitPerMinute);

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      log?.error?.(bodyResult.error);
      respondJson(res, bodyResult.statusCode, { error: bodyResult.error });
      return;
    }

    const timestamp = getHeader(req, "timestamp");
    const sign = getHeader(req, "sign");
    if (!account.appSecret) {
      log?.warn?.("DingTalk appSecret not configured; skipping sign verification");
    } else if (
      !timestamp ||
      !sign ||
      !verifyDingTalkSign({ timestamp, sign, appSecret: account.appSecret })
    ) {
      log?.warn?.("DingTalk webhook sign verification failed");
      respondJson(res, 401, { error: "Invalid sign" });
      return;
    }

    const payload = parsePayload(bodyResult.body);
    if (!payload) {
      respondJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const senderId = payload.senderId ?? "";
    const auth = authorizeUserForDm(senderId, account.dmPolicy, account.allowFrom);
    if (!auth.allowed) {
      if (auth.reason === "allowlist-empty") {
        respondJson(res, 403, { error: "Allowlist is empty" });
        return;
      }
      if (auth.reason === "not-allowlisted") {
        respondJson(res, 403, { error: "User not authorized" });
        return;
      }
      respondJson(res, 403, { error: "Not allowed" });
      return;
    }

    if (!checkRateLimit(rateLimiter, senderId)) {
      log?.warn?.(`DingTalk rate limit exceeded: ${senderId}`);
      respondJson(res, 429, { error: "Rate limit exceeded" });
      return;
    }

    const textContent =
      payload.msgtype === "text" && payload.text?.content
        ? sanitizeInput(payload.text.content)
        : "";
    if (!textContent) {
      respondJson(res, 200, {});
      return;
    }

    const sessionWebhook = payload.sessionWebhook;
    const sessionWebhookExpiredTime = payload.sessionWebhookExpiredTime ?? 0;
    const conversationId = payload.conversationId ?? "";
    const conversationType = payload.conversationType ?? "1";
    const chatType = conversationType === "2" ? "group" : "direct";
    const senderNick = payload.senderNick ?? senderId;
    const sessionKey = `dingtalk:${account.accountId}:${conversationId || senderId}`;
    const from = `dingtalk:${senderId}`;

    log?.info?.(
      `DingTalk message from ${senderNick} (${senderId}): ${textContent.slice(0, 80)}...`,
    );

    respondJson(res, 200, {});

    try {
      const currentCfg = await rt.config.loadConfig();
      const msgCtx = rt.channel.reply.finalizeInboundContext({
        Body: textContent,
        RawBody: textContent,
        CommandBody: textContent,
        From: from,
        To: from,
        SessionKey: sessionKey,
        AccountId: account.accountId,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: from,
        ChatType: chatType,
        SenderName: senderNick,
        SenderId: senderId,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        ConversationLabel: senderNick || senderId,
        Timestamp: Date.now(),
        CommandAuthorized: true,
      });

      await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: msgCtx,
        cfg: currentCfg,
        dispatcherOptions: {
          deliver: async (payload: { text?: string; body?: string }) => {
            const text = payload?.text ?? payload?.body;
            if (text && sessionWebhook && Date.now() < sessionWebhookExpiredTime) {
              await sendViaSessionWebhook(sessionWebhook, text);
              log?.info?.(`DingTalk reply sent to ${senderNick}`);
            } else if (text) {
              log?.warn?.("DingTalk sessionWebhook missing or expired; reply not sent");
            }
          },
          onReplyStart: () => {
            log?.info?.(`DingTalk agent reply started for ${senderId}`);
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error?.(`DingTalk deliver error: ${msg}`);
    }
  };
}
