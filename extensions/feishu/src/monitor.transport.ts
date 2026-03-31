import * as http from "http";
import crypto from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  applyBasicWebhookRequestGuards,
  isRequestBodyLimitError,
  type RuntimeEnv,
  installRequestBodyLimitGuard,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../runtime-api.js";
import { createFeishuWSClient } from "./client.js";
import {
  botNames,
  botOpenIds,
  FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
  FEISHU_WEBHOOK_MAX_BODY_BYTES,
  feishuWebhookRateLimiter,
  httpServers,
  recordWebhookStatus,
  wsClients,
} from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type MonitorTransportParams = {
  account: ResolvedFeishuAccount;
  accountId: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  eventDispatcher: Lark.EventDispatcher;
};

function isFeishuWebhookPayload(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildFeishuWebhookEnvelope(
  req: http.IncomingMessage,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.assign(Object.create({ headers: req.headers }), payload) as Record<string, unknown>;
}

function parseFeishuWebhookPayload(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return isFeishuWebhookPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the inner challenge payload, decrypting if the outer body is
 * `{ "encrypt": "..." }`.  Returns `null` when the payload is not a
 * `url_verification` challenge or when decryption fails.
 */
function resolveChallenge(
  payload: Record<string, unknown>,
  encryptKey: string,
): { challenge: string; token?: string } | null {
  try {
    let inner: Record<string, unknown>;
    if (typeof payload["encrypt"] === "string" && encryptKey) {
      const key = crypto.createHash("sha256").update(encryptKey).digest();
      const buf = Buffer.from(payload["encrypt"] as string, "base64");
      const iv = buf.subarray(0, 16);
      const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
      const decrypted = decipher.update(buf.subarray(16)) + decipher.final("utf8");
      const parsed: unknown = JSON.parse(decrypted);
      if (!isFeishuWebhookPayload(parsed)) return null;
      inner = parsed;
    } else {
      inner = payload;
    }
    if (inner["type"] !== "url_verification" || typeof inner["challenge"] !== "string") {
      return null;
    }
    return {
      challenge: inner["challenge"] as string,
      token: typeof inner["token"] === "string" ? (inner["token"] as string) : undefined,
    };
  } catch {
    return null;
  }
}

function isFeishuWebhookSignatureValid(params: {
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  encryptKey?: string;
}): boolean {
  const encryptKey = params.encryptKey?.trim();
  if (!encryptKey) {
    return true;
  }

  const timestampHeader = params.headers["x-lark-request-timestamp"];
  const nonceHeader = params.headers["x-lark-request-nonce"];
  const signatureHeader = params.headers["x-lark-signature"];
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const computedSignature = crypto
    .createHash("sha256")
    .update(timestamp + nonce + encryptKey + params.rawBody)
    .digest("hex");
  return timingSafeEqualString(computedSignature, signature);
}

function respondText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

export async function monitorWebSocket({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  log(`feishu[${accountId}]: starting WebSocket connection...`);

  const wsClient = createFeishuWSClient(account);
  wsClients.set(accountId, wsClient);

  return new Promise((resolve, reject) => {
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      abortSignal?.removeEventListener("abort", handleAbort);
      try {
        wsClient.close();
      } catch (err) {
        error(`feishu[${accountId}]: error closing WebSocket client: ${String(err)}`);
      } finally {
        wsClients.delete(accountId);
        botOpenIds.delete(accountId);
        botNames.delete(accountId);
      }
    };

    function handleAbort() {
      log(`feishu[${accountId}]: abort signal received, stopping`);
      cleanup();
      resolve();
    }

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      wsClient.start({ eventDispatcher });
      log(`feishu[${accountId}]: WebSocket client started`);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

export async function monitorWebhook({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const port = account.config.webhookPort ?? 3000;
  const path = account.config.webhookPath ?? "/feishu/events";
  const host = account.config.webhookHost ?? "127.0.0.1";

  log(`feishu[${accountId}]: starting Webhook server on ${host}:${port}, path ${path}...`);

  const server = http.createServer();

  server.on("request", (req, res) => {
    res.on("finish", () => {
      recordWebhookStatus(runtime, accountId, path, res.statusCode);
    });

    const rateLimitKey = `${accountId}:${path}:${req.socket.remoteAddress ?? "unknown"}`;
    if (
      !applyBasicWebhookRequestGuards({
        req,
        res,
        rateLimiter: feishuWebhookRateLimiter,
        rateLimitKey,
        nowMs: Date.now(),
        requireJsonContentType: true,
      })
    ) {
      return;
    }

    const guard = installRequestBodyLimitGuard(req, res, {
      maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
      responseFormat: "text",
    });
    if (guard.isTripped()) {
      return;
    }

    void (async () => {
      try {
        const rawBody = await readRequestBodyWithLimit(req, {
          maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
          timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
        });
        if (guard.isTripped() || res.writableEnded) {
          return;
        }

        const payload = parseFeishuWebhookPayload(rawBody);
        if (!payload) {
          respondText(res, 400, "Invalid JSON");
          return;
        }

        // Feishu does not send signature headers on url_verification challenge
        // requests, even when Encrypt Key is configured. Handle the challenge
        // before signature verification so the initial URL setup succeeds.
        // Validate the verification token embedded in the challenge payload to
        // prevent unauthenticated callers from getting a successful response.
        // See: https://open.larksuite.com/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
        const challengeResult = resolveChallenge(payload, account.encryptKey ?? "");
        if (challengeResult) {
          if (
            account.verificationToken &&
            (!challengeResult.token ||
              !timingSafeEqualString(challengeResult.token, account.verificationToken))
          ) {
            respondText(res, 401, "Invalid verification token");
            return;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ challenge: challengeResult.challenge }));
          return;
        }

        // Verify signature for all non-challenge event pushes.
        if (
          !isFeishuWebhookSignatureValid({
            headers: req.headers,
            rawBody,
            encryptKey: account.encryptKey,
          })
        ) {
          respondText(res, 401, "Invalid signature");
          return;
        }

        const value = await eventDispatcher.invoke(buildFeishuWebhookEnvelope(req, payload), {
          needCheck: false,
        });
        if (!res.headersSent) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(value));
        }
      } catch (err) {
        if (isRequestBodyLimitError(err)) {
          if (!res.headersSent) {
            respondText(res, err.statusCode, requestBodyErrorToText(err.code));
          }
          return;
        }
        if (!guard.isTripped()) {
          error(`feishu[${accountId}]: webhook handler error: ${String(err)}`);
          if (!res.headersSent) {
            respondText(res, 500, "Internal Server Error");
          }
        }
      } finally {
        guard.dispose();
      }
    })();
  });

  httpServers.set(accountId, server);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.close();
      httpServers.delete(accountId);
      botOpenIds.delete(accountId);
      botNames.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping Webhook server`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    server.listen(port, host, () => {
      log(`feishu[${accountId}]: Webhook server listening on ${host}:${port}`);
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}
