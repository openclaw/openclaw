import * as http from "http";
import crypto from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import { safeEqualSecret } from "openclaw/plugin-sdk/browser-support";
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

type FeishuStatusSink = (patch: {
  connected?: boolean;
  reconnectAttempts?: number;
  lastConnectedAt?: number | null;
  lastDisconnect?: {
    at: number;
    error?: string;
  } | null;
  lastError?: string | null;
}) => void;

export type MonitorTransportParams = {
  account: ResolvedFeishuAccount;
  accountId: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  eventDispatcher: Lark.EventDispatcher;
  statusSink?: FeishuStatusSink;
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
  return safeEqualSecret(computedSignature, signature);
}

function respondText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

type FeishuWSLifecycleLogger = {
  error: (...msg: unknown[]) => void | Promise<void>;
  warn: (...msg: unknown[]) => void | Promise<void>;
  info: (...msg: unknown[]) => void | Promise<void>;
  debug: (...msg: unknown[]) => void | Promise<void>;
  trace: (...msg: unknown[]) => void | Promise<void>;
};

function formatLoggerArgs(args: unknown[]): string {
  return args
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(" ")
    .trim();
}

function normalizeFeishuWsError(text: string): string {
  if (text.includes("1000040350") || text.includes("exceed_conn_limit")) {
    return "Feishu WebSocket connection limit reached (1000040350 exceed_conn_limit). Another OpenClaw gateway instance is likely already connected.";
  }
  if (text.includes("PingInterval")) {
    return "Feishu WebSocket reconnect failed while parsing PingInterval. This usually follows an upstream connection-limit or system-busy response.";
  }
  if (text.includes("unable to connect to the server after trying")) {
    return "Feishu WebSocket reconnect attempts failed to reach the server.";
  }
  return text;
}

export function createFeishuWsLifecycleLogger(params: {
  accountId: string;
  runtime?: RuntimeEnv;
  statusSink?: FeishuStatusSink;
}): FeishuWSLifecycleLogger {
  const { accountId, runtime, statusSink } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  let reconnectAttempts = 0;

  const updateConnected = (connected: boolean, next?: { error?: string | null }) => {
    const now = Date.now();
    if (connected) {
      reconnectAttempts = 0;
      statusSink?.({
        connected: true,
        reconnectAttempts,
        lastConnectedAt: now,
        lastDisconnect: null,
        lastError: null,
      });
      return;
    }
    reconnectAttempts += 1;
    statusSink?.({
      connected: false,
      reconnectAttempts,
      lastDisconnect: {
        at: now,
        ...(next?.error ? { error: next.error } : {}),
      },
      ...(next?.error === undefined ? {} : { lastError: next.error }),
    });
  };

  return {
    info: (...args: unknown[]) => {
      log(...args);
      const text = formatLoggerArgs(args);
      if (text.includes("reconnect success") || text.includes("ws client ready")) {
        updateConnected(true);
        return;
      }
      if (
        text.includes("reconnect") ||
        text.includes("unable to connect to the server after trying")
      ) {
        updateConnected(false);
        return;
      }
    },
    warn: (...args: unknown[]) => {
      log(...args);
    },
    debug: (...args: unknown[]) => {
      log(...args);
      const text = formatLoggerArgs(args);
      if (text.includes("[ws]") && text.includes("reconnect success")) {
        updateConnected(true);
      }
    },
    trace: (...args: unknown[]) => {
      log(...args);
    },
    error: (...args: unknown[]) => {
      error(...args);
      const text = formatLoggerArgs(args);
      if (!text.includes("[ws]")) {
        return;
      }
      if (
        text.includes("ws connect failed") ||
        text.includes("connect failed") ||
        text.includes("ws error") ||
        text.includes("1000040350") ||
        text.includes("exceed_conn_limit") ||
        text.includes("PingInterval")
      ) {
        updateConnected(false, { error: normalizeFeishuWsError(text) });
      }
    },
  };
}

export async function monitorWebSocket({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
  statusSink,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  log(`feishu[${accountId}]: starting WebSocket connection...`);

  const wsClient = createFeishuWSClient(account, {
    logger: createFeishuWsLifecycleLogger({ accountId, runtime, statusSink }),
  });
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
      statusSink?.({
        connected: false,
        lastDisconnect: {
          at: Date.now(),
          error: "abort signal received",
        },
      });
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
  statusSink,
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
      statusSink?.({
        connected: true,
        reconnectAttempts: 0,
        lastConnectedAt: Date.now(),
        lastDisconnect: null,
        lastError: null,
      });
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}
