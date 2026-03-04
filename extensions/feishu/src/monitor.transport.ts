import * as http from "http";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  applyBasicWebhookRequestGuards,
  type RuntimeEnv,
  installRequestBodyLimitGuard,
} from "openclaw/plugin-sdk/feishu";
import { createFeishuWSClient } from "./client.js";
import {
  botOpenIds,
  FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
  FEISHU_WEBHOOK_MAX_BODY_BYTES,
  feishuWebhookRateLimiter,
  httpServers,
  recordWebhookStatus,
  wsClients,
} from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

type FeishuMonitorStatusSink = (patch: {
  connected?: boolean;
  lastConnectedAt?: number;
  lastDisconnect?: { at: number; status?: number; error?: string };
  lastEventAt?: number;
  lastInboundAt?: number;
  lastError?: string | null;
}) => void;

export type MonitorTransportParams = {
  account: ResolvedFeishuAccount;
  accountId: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  eventDispatcher: Lark.EventDispatcher;
  statusSink?: FeishuMonitorStatusSink;
};

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

  const wsClient = createFeishuWSClient(account);
  wsClients.set(accountId, wsClient);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      wsClients.delete(accountId);
      botOpenIds.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping`);
      statusSink?.({
        connected: false,
        lastDisconnect: { at: Date.now(), error: "abort" },
      });
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      statusSink?.({
        connected: false,
        lastDisconnect: { at: Date.now(), error: "aborted-before-start" },
      });
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      wsClient.start({ eventDispatcher });
      log(`feishu[${accountId}]: WebSocket client started`);
      statusSink?.({
        connected: true,
        lastConnectedAt: Date.now(),
        lastEventAt: Date.now(),
        lastError: null,
      });
    } catch (err) {
      statusSink?.({
        connected: false,
        lastDisconnect: { at: Date.now(), error: String(err) },
        lastError: String(err),
      });
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
  statusSink,
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
    const now = Date.now();
    statusSink?.({
      connected: true,
      lastEventAt: now,
      lastInboundAt: now,
      lastError: null,
    });
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
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping Webhook server`);
      statusSink?.({
        connected: false,
        lastDisconnect: { at: Date.now(), error: "abort" },
      });
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      statusSink?.({
        connected: false,
        lastDisconnect: { at: Date.now(), error: "aborted-before-start" },
      });
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    server.listen(port, host, () => {
      log(`feishu[${accountId}]: Webhook server listening on ${host}:${port}`);
      statusSink?.({
        connected: true,
        lastConnectedAt: Date.now(),
        lastEventAt: Date.now(),
        lastError: null,
      });
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      statusSink?.({
        connected: false,
        lastDisconnect: { at: Date.now(), error: String(err) },
        lastError: String(err),
      });
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}
