import WebSocket from "ws";
import type { PluginRuntime } from "../api.js";
import { resolveConfiguredSecretInputString, type OpenClawConfig } from "../runtime-api.js";
import { collectHeadersFromRecord } from "./auth.js";
import type { ConfiguredWebhookRelayConfig } from "./config.js";
import {
  handleWebhookEnvelope,
  type ScheduleSessionTurn,
  type WebhookAgentCompletionDispatch,
  type WebhookLogger,
  type WebhookTarget,
} from "./http.js";
import { createInMemoryIdempotencyRecords, type WebhookIdempotencyStore } from "./idempotency.js";

type LoadChannelOutboundAdapter = PluginRuntime["channel"]["outbound"]["loadAdapter"];

export type WebhookRelayConnector = {
  start: () => void;
  stop: () => void;
};

type RelayEnvelopeMessage = {
  id?: string;
  path?: string;
  routePath?: string;
  headers?: Record<string, string | string[] | number | boolean | null | undefined>;
  body?: unknown;
  rawBody?: string;
};

function decodeRelayMessage(data: WebSocket.RawData): unknown {
  const text = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data.map((entry) => Buffer.from(entry))).toString("utf8")
        : String(data);
  return JSON.parse(text);
}

function normalizeRelayEnvelopeMessage(value: unknown): RelayEnvelopeMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as RelayEnvelopeMessage;
  if (typeof record.path !== "string" && typeof record.routePath !== "string") {
    return undefined;
  }
  if (typeof record.rawBody !== "string" && record.body === undefined) {
    return undefined;
  }
  return record;
}

function serializeRelayBody(message: RelayEnvelopeMessage): string {
  if (typeof message.rawBody === "string") {
    return message.rawBody;
  }
  return JSON.stringify(message.body);
}

function safeSend(socket: WebSocket | null, payload: unknown, logger?: WebhookLogger): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(payload));
  } catch (error) {
    logger?.warn?.(
      `[webhooks] relay ack send failed: ${String(error instanceof Error ? error.message : error)}`,
    );
  }
}

async function buildWebSocketHeaders(params: {
  cfg: OpenClawConfig;
  relay: ConfiguredWebhookRelayConfig;
}): Promise<Record<string, string> | undefined> {
  if (!params.relay.token) {
    return undefined;
  }
  const resolved =
    typeof params.relay.token === "string"
      ? { value: params.relay.token }
      : await resolveConfiguredSecretInputString({
          config: params.cfg,
          env: process.env,
          value: params.relay.token,
          path: "plugins.entries.webhooks.config.relay.token",
        });
  if (!resolved.value) {
    return undefined;
  }
  const tokenValue =
    params.relay.tokenHeader.toLowerCase() === "authorization"
      ? `Bearer ${resolved.value}`
      : resolved.value;
  return { [params.relay.tokenHeader]: tokenValue };
}

export function createWebhookRelayConnector(params: {
  cfg: OpenClawConfig;
  relay: ConfiguredWebhookRelayConfig;
  targetsByPath: Map<string, WebhookTarget[]>;
  idempotencyStore?: WebhookIdempotencyStore;
  scheduleSessionTurn?: ScheduleSessionTurn;
  onAgentCompletionDispatch?: (dispatch: WebhookAgentCompletionDispatch) => void | Promise<void>;
  loadChannelOutboundAdapter?: LoadChannelOutboundAdapter;
  logger?: WebhookLogger;
  webSocketFactory?: (url: string, options?: WebSocket.ClientOptions) => WebSocket;
}): WebhookRelayConnector {
  const idempotencyRecords = createInMemoryIdempotencyRecords();
  const webSocketFactory =
    params.webSocketFactory ?? ((url, options) => new WebSocket(url, options));
  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) {
      return;
    }
    reconnectAttempts += 1;
    const baseDelay = Math.min(
      params.relay.reconnect.maxDelayMs,
      params.relay.reconnect.minDelayMs * 2 ** Math.min(reconnectAttempts - 1, 6),
    );
    const jitter = Math.floor(Math.random() * Math.min(1_000, baseDelay));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, baseDelay + jitter);
  };

  const handleMessage = async (message: RelayEnvelopeMessage) => {
    const path = message.path ?? message.routePath;
    if (!path) {
      return;
    }
    const targets = params.targetsByPath.get(path);
    if (!targets?.length) {
      const body = { ok: false, statusCode: 404, error: "route_not_found" };
      safeSend(socket, { type: "webhook.result", id: message.id, ...body }, params.logger);
      return;
    }
    const result = await handleWebhookEnvelope({
      cfg: params.cfg,
      targets,
      envelope: {
        path,
        headers: collectHeadersFromRecord(message.headers),
        rawBody: serializeRelayBody(message),
      },
      idempotencyRecords,
      idempotencyStore: params.idempotencyStore,
      scheduleSessionTurn: params.scheduleSessionTurn,
      onAgentCompletionDispatch: params.onAgentCompletionDispatch,
      loadChannelOutboundAdapter: params.loadChannelOutboundAdapter,
      logger: params.logger,
    });
    if (params.relay.ack) {
      safeSend(
        socket,
        {
          type: "webhook.result",
          id: message.id,
          ok: result.statusCode >= 200 && result.statusCode < 300,
          statusCode: result.statusCode,
          body: result.body,
        },
        params.logger,
      );
    }
  };

  const connect = async () => {
    if (stopped) {
      return;
    }
    clearReconnectTimer();
    const headers = await buildWebSocketHeaders({ cfg: params.cfg, relay: params.relay });
    const nextSocket = webSocketFactory(params.relay.url, headers ? { headers } : undefined);
    socket = nextSocket;
    nextSocket.on("open", () => {
      if (socket !== nextSocket) {
        return;
      }
      reconnectAttempts = 0;
      params.logger?.info?.(`[webhooks] relay websocket connected`);
    });
    nextSocket.on("message", (data) => {
      if (socket !== nextSocket) {
        return;
      }
      void (async () => {
        try {
          const decoded = decodeRelayMessage(data);
          const message = normalizeRelayEnvelopeMessage(decoded);
          if (!message) {
            params.logger?.warn?.("[webhooks] relay ignored invalid message envelope");
            return;
          }
          await handleMessage(message);
        } catch (error) {
          params.logger?.warn?.(
            `[webhooks] relay message handling failed: ${String(
              error instanceof Error ? error.message : error,
            )}`,
          );
        }
      })();
    });
    nextSocket.on("close", (code) => {
      if (socket !== nextSocket) {
        return;
      }
      socket = null;
      params.logger?.warn?.(`[webhooks] relay websocket closed (${code})`);
      scheduleReconnect();
    });
    nextSocket.on("error", (error) => {
      if (socket !== nextSocket) {
        return;
      }
      params.logger?.warn?.(
        `[webhooks] relay websocket error: ${String(
          error instanceof Error ? error.message : error,
        )}`,
      );
    });
  };

  return {
    start() {
      stopped = false;
      void connect();
    },
    stop() {
      stopped = true;
      clearReconnectTimer();
      socket?.close(1000, "OpenClaw webhooks relay connector stopped");
      socket = null;
    },
  };
}
