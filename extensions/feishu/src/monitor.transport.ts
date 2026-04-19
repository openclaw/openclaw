import * as http from "http";
import crypto from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import { waitForAbortableDelay } from "./async.js";
import { createFeishuWSClient } from "./client.js";
import {
  applyBasicWebhookRequestGuards,
  type RuntimeEnv,
  installRequestBodyLimitGuard,
  readWebhookBodyOrReject,
  safeEqualSecret,
} from "./monitor-transport-runtime-api.js";
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
    return false;
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
  return safeEqualSecret(computedSignature, signature);
}

function respondText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

// Exponential backoff delays for WebSocket reconnection attempts.
// After exhausting these, retry indefinitely at the max interval.
export const WS_RECONNECT_BACKOFF_DELAYS_MS = [
  5_000, // 5s
  10_000, // 10s
  30_000, // 30s
  60_000, // 1m
  120_000, // 2m
] as const;

function getReconnectDelayMs(attempt: number): number {
  if (attempt < WS_RECONNECT_BACKOFF_DELAYS_MS.length) {
    return WS_RECONNECT_BACKOFF_DELAYS_MS[attempt];
  }
  return WS_RECONNECT_BACKOFF_DELAYS_MS[WS_RECONNECT_BACKOFF_DELAYS_MS.length - 1];
}

/**
 * Start a single WebSocket client session. Resolves when the abort signal
 * fires or the client encounters an unrecoverable startup error.
 * Rejects if the initial `start()` call throws synchronously.
 */
async function startWebSocketSession({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
}: MonitorTransportParams): Promise<{ reason: "aborted" | "start-error"; error?: unknown }> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const wsClient = await createFeishuWSClient(account);
  wsClients.set(accountId, wsClient);

  return new Promise((resolve) => {
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      abortSignal?.removeEventListener("abort", handleAbort);
      try {
        wsClient.close();
      } catch (err) {
        error(`feishu[${accountId}]: error closing WebSocket client: ${String(err)}`);
      } finally {
        wsClients.delete(accountId);
      }
    };

    function handleAbort() {
      log(`feishu[${accountId}]: abort signal received, stopping`);
      cleanup();
      resolve({ reason: "aborted" });
    }

    if (abortSignal?.aborted) {
      cleanup();
      resolve({ reason: "aborted" });
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      void wsClient.start({ eventDispatcher });
      log(`feishu[${accountId}]: WebSocket client started`);
    } catch (err) {
      cleanup();
      resolve({ reason: "start-error", error: err });
    }
  });
}

export async function monitorWebSocket(params: MonitorTransportParams): Promise<void> {
  const { accountId, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  for (let attempt = 0; ; attempt += 1) {
    if (abortSignal?.aborted) {
      return;
    }

    if (attempt > 0) {
      const delayMs = getReconnectDelayMs(attempt - 1);
      log(`feishu[${accountId}]: WebSocket reconnect attempt ${attempt} in ${delayMs / 1000}s...`);
      const elapsed = await waitForAbortableDelay(delayMs, abortSignal);
      if (!elapsed) {
        return;
      }
    }

    log(
      `feishu[${accountId}]: starting WebSocket connection${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}...`,
    );

    const result = await startWebSocketSession(params);

    if (result.reason === "aborted") {
      return;
    }

    // start-error: the SDK's start() threw synchronously — retry
    const errorMsg = result.error instanceof Error ? result.error.message : "unknown error";
    error(`feishu[${accountId}]: WebSocket connection failed: ${errorMsg}`);
  }
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
  const encryptKey = account.encryptKey?.trim();
  if (!encryptKey) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires encryptKey`);
  }

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
        const body = await readWebhookBodyOrReject({
          req,
          res,
          maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
          timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
          profile: "pre-auth",
        });
        if (!body.ok || res.writableEnded) {
          return;
        }
        if (guard.isTripped()) {
          return;
        }
        const rawBody = body.value;

        // Reject invalid signatures before any JSON parsing to keep the auth boundary strict.
        if (
          !isFeishuWebhookSignatureValid({
            headers: req.headers,
            rawBody,
            encryptKey,
          })
        ) {
          respondText(res, 401, "Invalid signature");
          return;
        }

        const payload = parseFeishuWebhookPayload(rawBody);
        if (!payload) {
          respondText(res, 400, "Invalid JSON");
          return;
        }

        const { isChallenge, challenge } = Lark.generateChallenge(payload, {
          encryptKey,
        });
        if (isChallenge) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(challenge));
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
        error(`feishu[${accountId}]: webhook handler error: ${String(err)}`);
        if (!res.headersSent) {
          respondText(res, 500, "Internal Server Error");
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
