/**
 * WeChat MP 服务器配置: GET 验证, POST 接收消息.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk";
import { sendWeChatMPCustomerMessage } from "./client.js";
import {
  verifyWeChatMPSignature,
  authorizeUserForWeChatMP,
  getWeChatMPRateLimiter,
  checkWeChatMPRateLimit,
} from "./security.js";
import type { ResolvedWeChatMPAccount } from "./types.js";

const CHANNEL_ID = "wechat-mp";

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

function parseXmlText(xml: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = xml.indexOf(open);
  const j = xml.indexOf(close, i);
  if (i < 0 || j < 0) return undefined;
  const inner = xml.slice(i + open.length, j).trim();
  const cdataMatch = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return cdataMatch ? cdataMatch[1].trim() : inner;
}

function getQuery(req: IncomingMessage): Record<string, string> {
  const url = req.url ?? "";
  const i = url.indexOf("?");
  if (i < 0) return {};
  const out: Record<string, string> = {};
  for (const part of url.slice(i + 1).split("&")) {
    const [k, v] = part.split("=").map((s) => decodeURIComponent(s.replace(/\+/g, " ")));
    if (k) out[k] = v ?? "";
  }
  return out;
}

function respond(res: ServerResponse, statusCode: number, body: string, contentType?: string) {
  res.writeHead(statusCode, {
    "Content-Type": contentType ?? "text/plain; charset=utf-8",
  });
  res.end(body);
}

export interface WeChatMPWebhookHandlerDeps {
  account: ResolvedWeChatMPAccount;
  runtime: PluginRuntime;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

export function createWeChatMPWebhookHandler(deps: WeChatMPWebhookHandlerDeps) {
  const { account, runtime: rt, log } = deps;
  const rateLimiter = getWeChatMPRateLimiter(account.accountId, account.rateLimitPerMinute);

  return async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "";

    if (method === "GET") {
      const q = getQuery(req);
      const { signature, timestamp, nonce, echostr } = q;
      if (!account.token) {
        respond(res, 500, "token not configured");
        return;
      }
      if (
        !signature ||
        !timestamp ||
        !nonce ||
        !verifyWeChatMPSignature({ token: account.token, timestamp, nonce, signature })
      ) {
        respond(res, 403, "invalid signature");
        return;
      }
      respond(res, 200, echostr ?? "");
      return;
    }

    if (method !== "POST") {
      respond(res, 405, "Method not allowed");
      return;
    }

    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      respond(res, bodyResult.statusCode, bodyResult.error);
      return;
    }

    const fromUser = parseXmlText(bodyResult.body, "FromUserName");
    const toUser = parseXmlText(bodyResult.body, "ToUserName");
    const msgType = parseXmlText(bodyResult.body, "MsgType");
    const content = parseXmlText(bodyResult.body, "Content");
    const msgId = parseXmlText(bodyResult.body, "MsgId");

    if (!fromUser) {
      respond(res, 200, "");
      return;
    }

    const auth = authorizeUserForWeChatMP(fromUser, account.dmPolicy, account.allowFrom);
    if (!auth.allowed) {
      respond(res, 200, "");
      return;
    }
    if (!checkWeChatMPRateLimit(rateLimiter, fromUser)) {
      log?.warn?.(`WeChat MP rate limit exceeded: ${fromUser}`);
      respond(res, 200, "");
      return;
    }

    const textContent = msgType === "text" && content ? content.trim() : "";
    if (!textContent) {
      respond(res, 200, "");
      return;
    }

    const sessionKey = `wechat-mp:${account.accountId}:${fromUser}`;
    const from = `wechat-mp:${fromUser}`;

    respond(res, 200, "");

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
        ChatType: "direct",
        SenderName: fromUser,
        SenderId: fromUser,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        ConversationLabel: fromUser,
        Timestamp: Date.now(),
        CommandAuthorized: true,
      });

      await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: msgCtx,
        cfg: currentCfg,
        dispatcherOptions: {
          deliver: async (payload: { text?: string; body?: string }) => {
            const text = payload?.text ?? payload?.body;
            if (text) {
              await sendWeChatMPCustomerMessage({
                account,
                touser: fromUser,
                text,
              });
              log?.info?.(`WeChat MP reply sent to ${fromUser}`);
            }
          },
          onReplyStart: () => {
            log?.info?.(`WeChat MP agent reply started for ${fromUser}`);
          },
        },
      });
    } catch (err) {
      const msgStr = err instanceof Error ? err.message : String(err);
      log?.error?.(`WeChat MP deliver error: ${msgStr}`);
    }
  };
}
