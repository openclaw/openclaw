import * as http from "http";
import crypto from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/infra-runtime";
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

function respondText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

/**
 * How long to wait after the SDK's most recent reconnect attempt before we
 * declare the connection dead and restart the supervisor cycle.
 *
 * The stall timer only starts ticking AFTER the SDK has made at least one
 * (re)connect attempt (lastConnectTime > 0), so a healthy long-lived socket
 * that never needs to reconnect never triggers a false stall.
 */
const FEISHU_WS_STALL_DETECT_MS = 90_000;

/**
 * How often we poll the SDK's reconnect-info to check for stalls.
 */
const FEISHU_WS_STALL_POLL_MS = 10_000;

/**
 * Backoff policy for the OpenClaw-level supervisor loop. Each cycle
 * represents the Lark SDK exhausting its own server-configured reconnect
 * budget. We back off before starting a fresh WSClient.
 */
const FEISHU_WS_SUPERVISOR_RECONNECT_POLICY = {
  initialMs: 5_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.25,
} as const;

/**
 * Start the Lark WSClient and return a promise that resolves once the SDK's
 * internal retry budget appears exhausted (stall detected) or abort is
 * signalled.
 *
 * Stall detection works by tracking `lastConnectTime` from the SDK's
 * reconnect-info. The stall clock only starts after the SDK records its first
 * connect attempt (lastConnectTime > 0), so a healthy, long-lived connection
 * that never needs to reconnect does NOT trigger a false stall.
 */
function runFeishuWSClientUntilDead(params: {
  wsClient: Lark.WSClient;
  eventDispatcher: Lark.EventDispatcher;
  accountId: string;
  log: (msg: string) => void;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { wsClient, eventDispatcher, accountId, log, abortSignal } = params;

  return new Promise<void>((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }

    wsClient.start({ eventDispatcher });
    log(`feishu[${accountId}]: WebSocket client started`);

    // The stall poller tracks changes in lastConnectTime. We only start the
    // idle clock once we see a non-zero lastConnectTime (i.e. the SDK has
    // actually attempted a connect). This avoids falsely tripping on a
    // healthy connection whose lastConnectTime has simply been stable since
    // the initial connect.
    let lastSeenConnectTime = 0;
    let lastActivityAt: number | null = null; // null = waiting for first connect

    const handleAbort = () => {
      clearInterval(stallPoller);
      resolve();
    };

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    const stallPoller = setInterval(() => {
      if (abortSignal?.aborted) {
        clearInterval(stallPoller);
        return;
      }

      const info = wsClient.getReconnectInfo();
      const currentConnectTime = info.lastConnectTime;

      if (currentConnectTime !== lastSeenConnectTime) {
        // SDK has (re)connected — reset the stall clock.
        lastSeenConnectTime = currentConnectTime;
        lastActivityAt = Date.now();
        return;
      }

      // Still waiting for the first connect: don't start the stall clock yet.
      if (lastActivityAt === null) {
        return;
      }

      const idleMs = Date.now() - lastActivityAt;
      if (idleMs >= FEISHU_WS_STALL_DETECT_MS) {
        log(
          `feishu[${accountId}]: WebSocket stall detected (no reconnect activity for ${Math.round(idleMs / 1000)}s after last connect); will restart supervisor cycle`,
        );
        clearInterval(stallPoller);
        abortSignal?.removeEventListener("abort", handleAbort);
        resolve();
      }
    }, FEISHU_WS_STALL_POLL_MS);
  });
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

  const cleanup = () => {
    wsClients.delete(accountId);
    botOpenIds.delete(accountId);
    botNames.delete(accountId);
  };

  if (abortSignal?.aborted) {
    cleanup();
    return;
  }

  let supervisorAttempt = 0;

  // Supervisor loop: each iteration creates a fresh WSClient and runs it until
  // either (a) abort is requested or (b) the SDK's internal retry budget is
  // exhausted. We then back off and start a new cycle.
  while (!abortSignal?.aborted) {
    log(
      `feishu[${accountId}]: starting WebSocket connection... (supervisor cycle ${supervisorAttempt + 1})`,
    );

    let wsClient: Lark.WSClient;
    try {
      wsClient = createFeishuWSClient(account);
    } catch (err) {
      // Non-recoverable config error (missing credentials, etc.).
      cleanup();
      throw err;
    }

    wsClients.set(accountId, wsClient);

    try {
      await runFeishuWSClientUntilDead({
        wsClient,
        eventDispatcher,
        accountId,
        log,
        abortSignal,
      });
    } finally {
      // Always close the stale SDK client before creating a fresh one.
      try {
        wsClient.close({ force: true });
      } catch {
        // Ignore close errors; the new client will start clean.
      }
    }

    if (abortSignal?.aborted) {
      break;
    }

    supervisorAttempt += 1;
    const delayMs = computeBackoff(FEISHU_WS_SUPERVISOR_RECONNECT_POLICY, supervisorAttempt);
    error(
      `feishu[${accountId}]: WebSocket supervisor restarting (attempt ${supervisorAttempt}) in ${Math.round(delayMs / 1000)}s`,
    );

    try {
      await sleepWithAbort(delayMs, abortSignal);
    } catch {
      // Abort during sleep — exit loop.
      break;
    }
  }

  cleanup();
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

        // Reject invalid signatures before any JSON parsing to keep the auth boundary strict.
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

        const payload = parseFeishuWebhookPayload(rawBody);
        if (!payload) {
          respondText(res, 400, "Invalid JSON");
          return;
        }

        const { isChallenge, challenge } = Lark.generateChallenge(payload, {
          encryptKey: account.encryptKey ?? "",
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
