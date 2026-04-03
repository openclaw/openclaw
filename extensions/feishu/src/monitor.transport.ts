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

function isMatchingFeishuVerificationToken(params: {
  payload: Record<string, unknown>;
  verificationToken?: string;
}): boolean {
  const expectedToken = params.verificationToken?.trim();
  if (!expectedToken) {
    return false;
  }
  const actualToken = typeof params.payload.token === "string" ? params.payload.token.trim() : "";
  return actualToken.length > 0 && timingSafeEqualString(actualToken, expectedToken);
}

function decryptFeishuWebhookPayload(params: {
  payload: Record<string, unknown>;
  encryptKey?: string;
}): Record<string, unknown> | null {
  const ciphertext =
    typeof params.payload.encrypt === "string" ? params.payload.encrypt.trim() : "";
  const encryptKey = params.encryptKey?.trim();
  if (!ciphertext || !encryptKey) {
    return null;
  }

  try {
    const encrypted = Buffer.from(ciphertext, "base64");
    if (encrypted.length <= 16) {
      return null;
    }
    const iv = encrypted.subarray(0, 16);
    const body = encrypted.subarray(16);
    const key = crypto.createHash("sha256").update(encryptKey).digest();
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    return parseFeishuWebhookPayload(plaintext);
  } catch {
    return null;
  }
}

function isAuthorizedFeishuChallenge(params: {
  payload: Record<string, unknown>;
  signatureValid: boolean;
  verificationToken?: string;
  encryptKey?: string;
}): boolean {
  if (params.signatureValid) {
    return true;
  }

  if (
    isMatchingFeishuVerificationToken({
      payload: params.payload,
      verificationToken: params.verificationToken,
    })
  ) {
    return true;
  }

  const decryptedPayload = decryptFeishuWebhookPayload({
    payload: params.payload,
    encryptKey: params.encryptKey,
  });
  return isMatchingFeishuVerificationToken({
    payload: decryptedPayload ?? {},
    verificationToken: params.verificationToken,
  });
}

function respondText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function respondJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
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
          const signatureValid = isFeishuWebhookSignatureValid({
            headers: req.headers,
            rawBody,
            encryptKey: account.encryptKey,
          });
          if (!signatureValid) {
            respondText(res, 401, "Invalid signature");
            return;
          }
          respondText(res, 400, "Invalid JSON");
          return;
        }

        const signatureValid = isFeishuWebhookSignatureValid({
          headers: req.headers,
          rawBody,
          encryptKey: account.encryptKey,
        });
        const { isChallenge, challenge } = Lark.generateChallenge(payload, {
          encryptKey: account.encryptKey ?? "",
        });
        if (isChallenge) {
          if (
            !isAuthorizedFeishuChallenge({
              payload,
              signatureValid,
              verificationToken: account.verificationToken,
              encryptKey: account.encryptKey,
            })
          ) {
            respondText(res, 401, "Invalid signature");
            return;
          }
          respondJson(res, 200, challenge);
          return;
        }

        if (!signatureValid) {
          respondText(res, 401, "Invalid signature");
          return;
        }

        const value = await eventDispatcher.invoke(buildFeishuWebhookEnvelope(req, payload), {
          needCheck: false,
        });
        if (!res.headersSent) {
          respondJson(res, 200, value);
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
