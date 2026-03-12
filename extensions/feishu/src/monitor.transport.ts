import * as http from "http";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  applyBasicWebhookRequestGuards,
  type RuntimeEnv,
  installRequestBodyLimitGuard,
} from "openclaw/plugin-sdk/feishu";
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
      if (!text.includes("[ws]")) {
        return;
      }
      if (text.includes("ws client ready")) {
        updateConnected(true);
        return;
      }
      if (text.includes("reconnect")) {
        updateConnected(false);
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
        text.includes("ws error")
      ) {
        updateConnected(false, { error: text });
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
  log(`feishu[${accountId}]: starting WebSocket connection...`);

  const wsClient = createFeishuWSClient(account, {
    logger: createFeishuWsLifecycleLogger({ accountId, runtime, statusSink }),
  });
  wsClients.set(accountId, wsClient);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      wsClients.delete(accountId);
      botOpenIds.delete(accountId);
      botNames.delete(accountId);
    };

    const handleAbort = () => {
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
    };

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
      abortSignal?.removeEventListener("abort", handleAbort);
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
  const webhookHandler = Lark.adaptDefault(path, eventDispatcher, { autoChallenge: true });

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

    void Promise.resolve(webhookHandler(req, res))
      .catch((err) => {
        if (!guard.isTripped()) {
          error(`feishu[${accountId}]: webhook handler error: ${String(err)}`);
        }
      })
      .finally(() => {
        guard.dispose();
      });
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
