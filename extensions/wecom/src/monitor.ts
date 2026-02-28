import * as crypto from "crypto";
import * as http from "http";
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import { installRequestBodyLimitGuard } from "openclaw/plugin-sdk";
import { resolveWeComAccount } from "./accounts.js";
import { handleWeComMessage, type WeComMessageEvent } from "./bot.js";
import { probeWeCom } from "./probe.js";
import type { ResolvedWeComAccount } from "./types.js";

export type MonitorWeComOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

const httpServers = new Map<string, http.Server>();
const chatHistoriesMap = new Map<string, Map<string, HistoryEntry[]>>();
const WECOM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const WECOM_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

/**
 * Verify WeCom webhook signature
 */
function verifyWeComSignature(
  signature: string,
  timestamp: string,
  nonce: string,
  body: string,
  token: string,
): boolean {
  const arr = [token, timestamp, nonce, body].sort();
  const str = arr.join("");
  const hash = crypto.createHash("sha1").update(str).digest("hex");
  return hash === signature;
}

/**
 * Decrypt WeCom message
 */
function decryptWeComMessage(
  encrypt: string,
  encodingAESKey: string,
): { message: string; corpId: string } {
  const key = Buffer.from(encodingAESKey + "=", "base64");
  const encryptBuffer = Buffer.from(encrypt, "base64");

  // Decrypt using key as IV (WeCom uses the key itself as IV)
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.slice(0, 16));
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(encryptBuffer), decipher.final()]);

  // Remove PKCS7 padding
  const pad = decrypted[decrypted.length - 1];
  decrypted = decrypted.slice(0, decrypted.length - pad);

  // Message structure: random(16) + msg_len(4) + msg(msg_len) + corpId
  // Skip random 16 bytes, read msg_len as network byte order (big-endian)
  const msgLen = decrypted.readUInt32BE(16);
  const message = decrypted.slice(20, 20 + msgLen).toString("utf8");
  const corpId = decrypted.slice(20 + msgLen).toString("utf8");

  return { message, corpId };
}

/**
 * Monitor WeCom webhook
 */
async function monitorWeComWebhook({
  cfg,
  account,
  runtime,
  abortSignal,
}: {
  cfg: ClawdbotConfig;
  account: ResolvedWeComAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { accountId } = account;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const port = account.config?.webhookPort ?? 3000;
  const path = account.config?.webhookPath ?? "/wecom/events";
  const host = account.config?.webhookHost ?? "127.0.0.1";
  const token = account.config?.token;
  const encodingAESKey = account.config?.encodingAESKey;

  if (!token || !encodingAESKey) {
    throw new Error(`WeCom account "${accountId}" requires token and encodingAESKey`);
  }

  log(`wecom[${accountId}]: starting Webhook server on ${host}:${port}, path ${path}...`);

  // Get or create chatHistories for this account
  let chatHistories = chatHistoriesMap.get(accountId);
  if (!chatHistories) {
    chatHistories = new Map<string, HistoryEntry[]>();
    chatHistoriesMap.set(accountId, chatHistories);
  }

  const server = http.createServer();

  server.on("request", async (req, res) => {
    // Extract pathname from URL (ignore query parameters)
    const urlPath = req.url?.split("?")[0];
    if (urlPath !== path) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    // Handle URL verification (GET request)
    if (req.method === "GET") {
      // Parse URL and get URL-decoded parameters
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const msgSignature = url.searchParams.get("msg_signature");
      const timestamp = url.searchParams.get("timestamp");
      const nonce = url.searchParams.get("nonce");
      const echostr = url.searchParams.get("echostr");

      if (!msgSignature || !timestamp || !nonce || !echostr) {
        res.statusCode = 400;
        res.end("Bad Request");
        return;
      }

      try {
        // Verify signature using URL-decoded echostr
        if (!verifyWeComSignature(msgSignature, timestamp, nonce, echostr, token)) {
          error(`wecom[${accountId}]: signature verification failed`);
          res.statusCode = 401;
          res.end("Unauthorized");
          return;
        }

        // Decrypt echostr
        const { message, corpId } = decryptWeComMessage(echostr, encodingAESKey);

        // Verify corpId matches configuration
        const expectedCorpId = account.corpId;
        if (corpId !== expectedCorpId) {
          error(`wecom[${accountId}]: corpId mismatch, expected=${expectedCorpId}, got=${corpId}`);
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        // Return plain text without quotes, BOM, or newlines
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(message);
        log(`wecom[${accountId}]: URL verification successful`);
      } catch (err) {
        error(`wecom[${accountId}]: URL verification error: ${String(err)}`);
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
      return;
    }

    // Handle message events (POST request)
    if (req.method === "POST") {
      const guard = installRequestBodyLimitGuard(req, res, {
        maxBytes: WECOM_WEBHOOK_MAX_BODY_BYTES,
        timeoutMs: WECOM_WEBHOOK_BODY_TIMEOUT_MS,
        responseFormat: "text",
      });

      if (guard.isTripped()) {
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        try {
          const body = Buffer.concat(chunks).toString("utf8");

          // Parse XML to extract Encrypt field
          const encryptMatch = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
          if (!encryptMatch) {
            error(`wecom[${accountId}]: failed to extract Encrypt from XML body`);
            res.statusCode = 400;
            res.end("Bad Request");
            return;
          }
          const encrypt = encryptMatch[1];

          const url = new URL(req.url!, `http://${req.headers.host}`);
          const msgSignature = url.searchParams.get("msg_signature");
          const timestamp = url.searchParams.get("timestamp");
          const nonce = url.searchParams.get("nonce");

          if (!msgSignature || !timestamp || !nonce) {
            res.statusCode = 400;
            res.end("Bad Request");
            return;
          }

          // Verify signature
          if (!verifyWeComSignature(msgSignature, timestamp, nonce, encrypt, token)) {
            error(`wecom[${accountId}]: signature verification failed`);
            res.statusCode = 401;
            res.end("Unauthorized");
            return;
          }

          // Decrypt message
          const { message } = decryptWeComMessage(encrypt, encodingAESKey);

          // Parse decrypted XML message
          const event: WeComMessageEvent = {
            ToUserName: message.match(/<ToUserName><!\[CDATA\[(.*?)\]\]><\/ToUserName>/)?.[1] || "",
            FromUserName:
              message.match(/<FromUserName><!\[CDATA\[(.*?)\]\]><\/FromUserName>/)?.[1] || "",
            CreateTime: Number.parseInt(
              message.match(/<CreateTime>(\d+)<\/CreateTime>/)?.[1] || "0",
            ),
            MsgType: message.match(/<MsgType><!\[CDATA\[(.*?)\]\]><\/MsgType>/)?.[1] || "",
            Content: message.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/)?.[1],
            MsgId: message.match(/<MsgId>(\d+)<\/MsgId>/)?.[1] || "",
            AgentID: message.match(/<AgentID>(\d+)<\/AgentID>/)?.[1] || "",
            PicUrl: message.match(/<PicUrl><!\[CDATA\[(.*?)\]\]><\/PicUrl>/)?.[1],
            MediaId: message.match(/<MediaId><!\[CDATA\[(.*?)\]\]><\/MediaId>/)?.[1],
            Title: message.match(/<Title><!\[CDATA\[(.*?)\]\]><\/Title>/)?.[1],
            Description: message.match(/<Description><!\[CDATA\[(.*?)\]\]><\/Description>/)?.[1],
            FileKey: message.match(/<FileKey><!\[CDATA\[(.*?)\]\]><\/FileKey>/)?.[1],
            Location_X: message.match(/<Location_X>(.*?)<\/Location_X>/)?.[1],
            Location_Y: message.match(/<Location_Y>(.*?)<\/Location_Y>/)?.[1],
            Scale: message.match(/<Scale>(\d+)<\/Scale>/)?.[1],
            Label: message.match(/<Label><!\[CDATA\[(.*?)\]\]><\/Label>/)?.[1],
            Url: message.match(/<Url><!\[CDATA\[(.*?)\]\]><\/Url>/)?.[1],
            ChatId: message.match(/<ChatId><!\[CDATA\[(.*?)\]\]><\/ChatId>/)?.[1],
            ChatType: message.match(/<ChatType><!\[CDATA\[(.*?)\]\]><\/ChatType>/)?.[1],
          };

          log(
            `wecom[${accountId}]: received message from ${event.FromUserName}, type=${event.MsgType}`,
          );

          // Handle message (fire and forget to avoid blocking response).
          // handleWeComMessage has its own try/catch and sends error replies internally.
          handleWeComMessage({
            cfg,
            event,
            runtime,
            chatHistories,
            accountId: accountId,
          }).catch((err) => {
            error(`wecom[${accountId}]: unexpected error handling message: ${String(err)}`);
          });

          res.statusCode = 200;
          res.end("success");
        } catch (err) {
          if (!guard.isTripped()) {
            error(`wecom[${accountId}]: webhook handler error: ${String(err)}`);
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        } finally {
          guard.dispose();
        }
      });
      return;
    }

    res.statusCode = 405;
    res.end("Method Not Allowed");
  });

  httpServers.set(accountId, server);

  return new Promise((resolve, reject) => {
    const cleanup = (callback?: () => void) => {
      server.close(() => {
        httpServers.delete(accountId);
        callback?.();
      });
    };

    const handleAbort = () => {
      log(`wecom[${accountId}]: abort signal received, stopping`);
      cleanup(() => resolve());
    };

    if (abortSignal?.aborted) {
      cleanup(() => resolve());
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    // Attach error handler before listen() so async bind failures (e.g. EADDRINUSE) are caught.
    server.on("error", (err) => {
      error(`wecom[${accountId}]: server error: ${String(err)}`);
      abortSignal?.removeEventListener("abort", handleAbort);
      cleanup(() => reject(err));
    });

    server.listen(port, host, () => {
      log(`wecom[${accountId}]: Webhook server listening on ${host}:${port}${path}`);
    });
  });
}

/**
 * Monitor WeCom provider
 */
export async function monitorWeComProvider(opts: MonitorWeComOpts): Promise<() => void> {
  const { config, runtime, abortSignal, accountId } = opts;

  if (!config) {
    throw new Error("Config is required");
  }

  const account = resolveWeComAccount({ cfg: config, accountId });

  if (!account.configured) {
    throw new Error(`WeCom account "${account.accountId}" is not configured`);
  }

  const log = runtime?.log ?? console.log;
  log(`wecom[${account.accountId}]: starting monitor...`);

  // Start webhook server and wait for it to be ready
  await monitorWeComWebhook({
    cfg: config,
    account,
    runtime,
    abortSignal,
  });

  // Return cleanup function
  return () => {
    const server = httpServers.get(account.accountId);
    if (server) {
      server.close();
      httpServers.delete(account.accountId);
    }
  };
}
