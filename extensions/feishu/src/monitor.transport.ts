import * as http from "http";
import crypto from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  applyBasicWebhookRequestGuards,
  readJsonBodyWithLimit,
  type RuntimeEnv,
  installRequestBodyLimitGuard,
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

/**
 * Supervisor reconnection policy for Feishu WebSocket.
 * Aligned with Slack/Telegram channel patterns (2s initial, 60s max, 1.8x factor).
 */
const FEISHU_WS_RECONNECT_POLICY = {
  initialMs: 2_000,
  maxMs: 60_000,
  factor: 1.8,
  jitter: 0.25,
} as const;

/**
 * Health check interval for detecting SDK silent death.
 *
 * The Lark SDK's WSClient manages its own reconnection internally, but after
 * exhausting `reconnectCount` attempts it stops silently — no error thrown, no
 * event emitted, no promise rejected. The only observable signal is that
 * `getReconnectInfo().nextConnectTime` stops advancing.
 *
 * We poll `getReconnectInfo()` at this interval. If `nextConnectTime` has not
 * advanced for `HEALTH_CHECK_STALE_MS`, we consider the SDK dead and recreate
 * the client from scratch.
 */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/**
 * How long `nextConnectTime` can remain unchanged before we declare the SDK
 * dead. Must be longer than the SDK's own `reconnectInterval` (server-sent,
 * typically ~10-30s) to avoid false positives during normal SDK reconnection.
 */
const HEALTH_CHECK_STALE_MS = 120_000;

function computeReconnectDelay(attempt: number): number {
  const { initialMs, maxMs, factor, jitter } = FEISHU_WS_RECONNECT_POLICY;
  const base = Math.min(initialMs * factor ** (attempt - 1), maxMs);
  const jitterRange = base * jitter;
  return base + (Math.random() * 2 - 1) * jitterRange;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<"slept" | "aborted"> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("slept"), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve("aborted");
      },
      { once: true },
    );
  });
}

function isNonRecoverableFeishuError(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("credentials not configured") ||
    msg.includes("app_id") ||
    msg.includes("invalid app") ||
    msg.includes("app has been disabled") ||
    msg.includes("app not exist")
  );
}

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

function isFeishuWebhookSignatureValid(params: {
  headers: http.IncomingHttpHeaders;
  payload: Record<string, unknown>;
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
    .update(timestamp + nonce + encryptKey + JSON.stringify(params.payload))
    .digest("hex");
  return timingSafeEqualString(computedSignature, signature);
}

function respondText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

/**
 * WebSocket supervisor loop for Feishu connections.
 *
 * ## Problem
 *
 * The Lark SDK's `WSClient.start()` is fire-and-forget: it kicks off an
 * internal reconnection loop but returns immediately without awaiting the
 * connection. When the SDK exhausts its server-configured `reconnectCount`
 * retries, it stops silently — no error, no event, no rejected promise.
 * The previous implementation parked on `abortSignal` after calling
 * `start()`, so it could never detect this silent death.
 *
 * ## Solution
 *
 * We use `WSClient.getReconnectInfo()` — an SDK method that exposes
 * `{ lastConnectTime, nextConnectTime }`. A periodic health check polls
 * this info; if `nextConnectTime` hasn't advanced for `HEALTH_CHECK_STALE_MS`
 * and the last successful connection is also old, the SDK has given up. We
 * then `close()` the dead client, apply exponential backoff, and create a
 * fresh `WSClient`.
 *
 * This mirrors the Slack and Telegram supervisor patterns already in
 * OpenClaw: an outer loop that owns client lifetime, with the transport
 * SDK managing short-term reconnection internally.
 */
export async function monitorWebSocket({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  let supervisorAttempts = 0;

  while (!abortSignal?.aborted) {
    log(`feishu[${accountId}]: starting WebSocket connection...`);

    const wsClient = createFeishuWSClient(account);
    wsClients.set(accountId, wsClient);

    let sdkDied = false;

    try {
      wsClient.start({ eventDispatcher });
      log(`feishu[${accountId}]: WebSocket client started`);

      // SDK started successfully; reset supervisor backoff.
      supervisorAttempts = 0;

      // Health-check loop: poll getReconnectInfo() to detect SDK silent death.
      // The SDK's internal reconnection updates nextConnectTime on each retry.
      // When it gives up, nextConnectTime freezes.
      let lastSeenNextConnectTime = 0;
      let staleStartedAt = 0;

      while (!abortSignal?.aborted) {
        const result = await sleepWithAbort(HEALTH_CHECK_INTERVAL_MS, abortSignal);
        if (result === "aborted") break;

        const info = wsClient.getReconnectInfo();
        const now = Date.now();

        if (info.nextConnectTime !== lastSeenNextConnectTime) {
          // SDK is still actively reconnecting — reset staleness tracker.
          lastSeenNextConnectTime = info.nextConnectTime;
          staleStartedAt = 0;
          continue;
        }

        // nextConnectTime hasn't changed. If lastConnectTime is recent,
        // the connection is healthy (no reconnection needed). Only flag
        // staleness when the last successful connect is also old.
        if (info.lastConnectTime > 0 && now - info.lastConnectTime < HEALTH_CHECK_STALE_MS) {
          staleStartedAt = 0;
          continue;
        }

        // Start or continue the staleness timer.
        if (staleStartedAt === 0) {
          staleStartedAt = now;
          continue;
        }

        if (now - staleStartedAt >= HEALTH_CHECK_STALE_MS) {
          error(
            `feishu[${accountId}]: SDK reconnection stale for ${Math.round((now - staleStartedAt) / 1000)}s, ` +
              `last connect at ${info.lastConnectTime ? new Date(info.lastConnectTime).toISOString() : "never"}. ` +
              `Recreating client.`,
          );
          sdkDied = true;
          break;
        }
      }
    } catch (err) {
      if (isNonRecoverableFeishuError(err)) {
        error(`feishu[${accountId}]: non-recoverable error, giving up: ${String(err)}`);
        break;
      }
      sdkDied = true;
      error(`feishu[${accountId}]: WebSocket start error: ${String(err)}`);
    } finally {
      try {
        wsClient.close({ force: true });
      } catch {
        // close() may throw if already torn down.
      }
      wsClients.delete(accountId);
      botOpenIds.delete(accountId);
      botNames.delete(accountId);
    }

    if (abortSignal?.aborted) break;

    if (sdkDied) {
      supervisorAttempts += 1;
      const delayMs = computeReconnectDelay(supervisorAttempts);
      log(
        `feishu[${accountId}]: supervisor reconnect attempt ${supervisorAttempts}, ` +
          `waiting ${Math.round(delayMs / 1000)}s...`,
      );
      const result = await sleepWithAbort(delayMs, abortSignal);
      if (result === "aborted") break;
      continue;
    }

    break;
  }

  log(`feishu[${accountId}]: WebSocket monitor stopped`);
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
        const bodyResult = await readJsonBodyWithLimit(req, {
          maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
          timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
        });
        if (guard.isTripped() || res.writableEnded) {
          return;
        }
        if (!bodyResult.ok) {
          if (bodyResult.code === "INVALID_JSON") {
            respondText(res, 400, "Invalid JSON");
          }
          return;
        }
        if (!isFeishuWebhookPayload(bodyResult.value)) {
          respondText(res, 400, "Invalid JSON");
          return;
        }

        if (
          !isFeishuWebhookSignatureValid({
            headers: req.headers,
            payload: bodyResult.value,
            encryptKey: account.encryptKey,
          })
        ) {
          respondText(res, 401, "Invalid signature");
          return;
        }

        const { isChallenge, challenge } = Lark.generateChallenge(bodyResult.value, {
          encryptKey: account.encryptKey ?? "",
        });
        if (isChallenge) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(challenge));
          return;
        }

        const value = await eventDispatcher.invoke(
          buildFeishuWebhookEnvelope(req, bodyResult.value),
          { needCheck: false },
        );
        if (!res.headersSent) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(value));
        }
      } catch (err) {
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
