/**
 * QQ Bot HTTP callback: op=13 verification, op=0 dispatch message events.
 * @see https://bot.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk";
import { sendQQMessage } from "./client.js";
import {
  verifyQQSignature,
  signQQVerification,
  authorizeUserForQQ,
  getQQRateLimiter,
  checkQQRateLimit,
} from "./security.js";
import type { ResolvedQQAccount } from "./types.js";
import type { QQCallbackPayload } from "./types.js";

const CHANNEL_ID = "qq";
const OP_DISPATCH = 0;
const OP_VERIFICATION = 13;

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

function parsePayload(body: string): QQCallbackPayload | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as QQCallbackPayload;
  } catch {
    return null;
  }
}

function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Extract text and sender from QQ event d (message create events). */
function extractMessageFromEvent(
  op: number,
  t: string | undefined,
  d: QQCallbackPayload["d"],
): {
  content: string;
  authorId: string;
  authorName: string;
  channelId?: string;
  msgId?: string;
} | null {
  if (op !== OP_DISPATCH || !d) return null;
  const content = typeof d.content === "string" ? d.content : "";
  const authorId = d.author?.id ?? "";
  const authorName = d.author?.username ?? authorId;
  const channelId = typeof d.channel_id === "string" ? d.channel_id : undefined;
  const msgId = typeof d.msg_id === "string" ? d.msg_id : (d.id as string | undefined);
  if (!content && !authorId) return null;
  return { content, authorId, authorName, channelId, msgId };
}

export interface QQWebhookHandlerDeps {
  account: ResolvedQQAccount;
  runtime: PluginRuntime;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

export function createQQWebhookHandler(deps: QQWebhookHandlerDeps) {
  const { account, runtime: rt, log } = deps;
  const rateLimiter = getQQRateLimiter(account.accountId, account.rateLimitPerMinute);

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      respondJson(res, bodyResult.statusCode, { error: bodyResult.error });
      return;
    }

    const payload = parsePayload(bodyResult.body);
    if (!payload) {
      respondJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    if (payload.op === OP_VERIFICATION) {
      const plainToken = payload.d?.plain_token ?? "";
      if (!plainToken) {
        respondJson(res, 400, { error: "Missing plain_token" });
        return;
      }
      try {
        const signature = await signQQVerification(plainToken, account.clientSecret);
        respondJson(res, 200, { plain_token: plainToken, signature });
      } catch (err) {
        log?.error?.(
          `QQ verification sign failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        respondJson(res, 500, { error: "Sign failed" });
      }
      return;
    }

    if (payload.op === OP_DISPATCH) {
      const timestamp = getHeader(req, "X-Signature-Timestamp");
      const signatureHex = getHeader(req, "X-Signature-Ed25519");
      if (account.clientSecret && (!timestamp || !signatureHex)) {
        respondJson(res, 401, { error: "Missing signature headers" });
        return;
      }
      if (account.clientSecret && timestamp && signatureHex) {
        const valid = await verifyQQSignature({
          timestamp,
          body: bodyResult.body,
          signatureHex,
          clientSecret: account.clientSecret,
        });
        if (!valid) {
          log?.warn?.("QQ callback signature verification failed");
          respondJson(res, 401, { error: "Invalid signature" });
          return;
        }
      }

      respondJson(res, 200, { op: 12 });

      const msg = extractMessageFromEvent(payload.op, payload.t, payload.d);
      if (!msg || !msg.content?.trim()) return;

      const auth = authorizeUserForQQ(msg.authorId, account.dmPolicy, account.allowFrom);
      if (!auth.allowed) return;
      if (!checkQQRateLimit(rateLimiter, msg.authorId)) {
        log?.warn?.(`QQ rate limit exceeded: ${msg.authorId}`);
        return;
      }

      const sessionKey = `qq:${account.accountId}:${msg.channelId ?? msg.authorId}`;
      const from = `qq:${msg.authorId}`;

      try {
        const currentCfg = await rt.config.loadConfig();
        const msgCtx = rt.channel.reply.finalizeInboundContext({
          Body: msg.content,
          RawBody: msg.content,
          CommandBody: msg.content,
          From: from,
          To: from,
          SessionKey: sessionKey,
          AccountId: account.accountId,
          OriginatingChannel: CHANNEL_ID,
          OriginatingTo: from,
          ChatType: msg.channelId ? "channel" : "direct",
          SenderName: msg.authorName,
          SenderId: msg.authorId,
          Provider: CHANNEL_ID,
          Surface: CHANNEL_ID,
          ConversationLabel: msg.authorName || msg.authorId,
          Timestamp: Date.now(),
          CommandAuthorized: true,
        });

        await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg: currentCfg,
          dispatcherOptions: {
            deliver: async (payload: { text?: string; body?: string }) => {
              const text = payload?.text ?? payload?.body;
              if (text && msg.channelId) {
                await sendQQMessage({
                  account,
                  channelId: msg.channelId,
                  content: text,
                  msgId: msg.msgId,
                });
                log?.info?.(`QQ reply sent to ${msg.authorName}`);
              } else if (text) {
                log?.warn?.("QQ reply: channelId missing, reply not sent");
              }
            },
            onReplyStart: () => {
              log?.info?.(`QQ agent reply started for ${msg.authorId}`);
            },
          },
        });
      } catch (err) {
        const msgStr = err instanceof Error ? err.message : String(err);
        log?.error?.(`QQ deliver error: ${msgStr}`);
      }
      return;
    }

    respondJson(res, 200, {});
  };
}
