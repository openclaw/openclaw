// Slack plugin module implements relay-backed inbound event transport.
import { Buffer } from "node:buffer";
import {
  computeBackoff,
  sleepWithAbort,
  warn,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import WebSocket, { type RawData } from "ws";
import type { SlackSendIdentity } from "../send.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMessageHandler } from "./message-handler.js";
import { formatUnknownError, SLACK_SOCKET_RECONNECT_POLICY } from "./reconnect-policy.js";

export type SlackRelaySourceConfig = {
  url: string;
  authToken: string;
  gatewayId: string;
};

export type SlackRelayIdentity = SlackSendIdentity;

export async function monitorSlackRelaySource(params: {
  config: SlackRelaySourceConfig;
  handleSlackMessage: SlackMessageHandler;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  setStatus?: (next: Record<string, unknown>) => void;
  setIdentity?: (identity: SlackRelayIdentity | undefined) => void;
}): Promise<void> {
  let reconnectAttempts = 0;
  while (!params.abortSignal?.aborted) {
    let ws: WebSocket | undefined;
    try {
      ws = await openRelayWebSocket(params.config, params.abortSignal);
      reconnectAttempts = 0;
      params.setStatus?.({
        connected: true,
        lastConnectedAt: Date.now(),
        healthState: "healthy",
        lastError: null,
      });
      params.runtime.log?.(`slack relay mode connected gateway_id:${params.config.gatewayId}`);
      await runRelayWebSocket({
        ws,
        handleSlackMessage: params.handleSlackMessage,
        runtime: params.runtime,
        abortSignal: params.abortSignal,
        setStatus: params.setStatus,
        setIdentity: params.setIdentity,
      });
    } catch (err) {
      if (params.abortSignal?.aborted) {
        break;
      }
      reconnectAttempts += 1;
      if (
        SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 &&
        reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts
      ) {
        throw err;
      }
      const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
      params.setStatus?.({
        connected: false,
        healthState: "disconnected",
        lastDisconnect: { at: Date.now(), error: formatUnknownError(err) },
        lastError: formatUnknownError(err),
      });
      params.runtime.log?.(
        warn(
          `slack relay mode disconnected; reconnecting in ${Math.round(delayMs / 1000)}s ` +
            `(attempt ${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts}) ` +
            `reason="${formatUnknownError(err)}"`,
        ),
      );
      await sleepWithAbort(delayMs, params.abortSignal);
    } finally {
      closeRelayWebSocket(ws);
      params.setIdentity?.(undefined);
    }
  }
}

function openRelayWebSocket(
  config: SlackRelaySourceConfig,
  abortSignal?: AbortSignal,
): Promise<WebSocket> {
  if (abortSignal?.aborted) {
    return Promise.reject(new Error("Slack relay websocket aborted before connect"));
  }
  return new Promise((resolve, reject) => {
    const url = buildRelayWebSocketUrl(config);
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.authToken}`,
      },
      handshakeTimeout: 30_000,
    });

    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(formatRelayClose(code, reason)));
    };
    const onAbort = () => {
      cleanup();
      closeRelayWebSocket(ws);
      reject(new Error("Slack relay websocket aborted during connect"));
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function runRelayWebSocket(params: {
  ws: WebSocket;
  handleSlackMessage: SlackMessageHandler;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  setStatus?: (next: Record<string, unknown>) => void;
  setIdentity?: (identity: SlackRelayIdentity | undefined) => void;
}): Promise<void> {
  let pending = Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      params.ws.off("message", onMessage);
      params.ws.off("error", onError);
      params.ws.off("close", onClose);
      params.abortSignal?.removeEventListener("abort", onAbort);
    };
    const settleResolve = () => {
      cleanup();
      pending.then(resolve, reject);
    };
    const settleReject = (error: Error) => {
      cleanup();
      pending.then(() => reject(error), reject);
    };
    const onMessage = (data: RawData) => {
      pending = pending
        .then(() =>
          handleRelayFrame({
            ws: params.ws,
            data,
            handleSlackMessage: params.handleSlackMessage,
            setStatus: params.setStatus,
            setIdentity: params.setIdentity,
          }),
        )
        .catch((err: unknown) => {
          params.runtime.error?.(`slack relay frame failed: ${formatUnknownError(err)}`);
        });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      const closeReason = formatRelayClose(code, reason);
      params.setStatus?.({
        connected: false,
        healthState: "disconnected",
        lastDisconnect: { at: Date.now(), error: closeReason },
      });
      settleReject(new Error(closeReason));
    };
    const onAbort = () => {
      closeRelayWebSocket(params.ws);
      settleResolve();
    };

    params.ws.on("message", onMessage);
    params.ws.once("error", onError);
    params.ws.once("close", onClose);
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function handleRelayFrame(params: {
  ws: WebSocket;
  data: RawData;
  handleSlackMessage: SlackMessageHandler;
  setStatus?: (next: Record<string, unknown>) => void;
  setIdentity?: (identity: SlackRelayIdentity | undefined) => void;
}): Promise<void> {
  const frame = parseRelayFrame(params.data);
  const hello = extractRelayHello(frame);
  if (hello) {
    params.setIdentity?.(hello.identity);
    params.setStatus?.({ relayIdentity: hello.identity ?? null });
    return;
  }
  const event = extractRelaySlackMessageEvent(frame);
  if (!event) {
    return;
  }
  const now = Date.now();
  params.setStatus?.({ lastEventAt: now, lastInboundAt: now });
  // Relay delivery is already authorized by its user-group mention route.
  await params.handleSlackMessage(event.message, {
    source: "message",
    wasMentioned: true,
  });
  sendRelayAck(params.ws, event.envelopeId);
}

function buildRelayWebSocketUrl(config: SlackRelaySourceConfig): string {
  const url = new URL(config.url);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Slack relay URL must use http(s) or ws(s): ${config.url}`);
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error(`Slack relay URL must include its websocket path: ${config.url}`);
  }
  url.searchParams.set("gateway_id", config.gatewayId);
  return url.toString();
}

function parseRelayFrame(data: RawData): unknown {
  const text = rawDataToString(data);
  return JSON.parse(text) as unknown;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function extractRelaySlackMessageEvent(
  frame: unknown,
): { envelopeId?: string; message: SlackMessageEvent } | undefined {
  const record = asRecord(frame);
  if (!record) {
    return undefined;
  }
  const event = asRecord(record.event);
  if (event?.type !== "message" || typeof event.channel !== "string") {
    return undefined;
  }
  return {
    envelopeId: stringValue(record.event_id),
    message: event as SlackMessageEvent,
  };
}

function extractRelayHello(
  frame: unknown,
): { identity: SlackRelayIdentity | undefined } | undefined {
  const record = asRecord(frame);
  if (!record || record.type !== "hello") {
    return undefined;
  }
  return {
    identity: extractRelayIdentity(record),
  };
}

function extractRelayIdentity(record: Record<string, unknown>): SlackRelayIdentity | undefined {
  const identityRecord = asRecord(record.slack_identity) ?? asRecord(record.slackIdentity);
  if (!identityRecord) {
    return undefined;
  }
  const username = normalizeOptionalString(identityRecord.username);
  const iconUrl =
    normalizeOptionalString(identityRecord.icon_url) ??
    normalizeOptionalString(identityRecord.iconUrl);
  const iconEmoji =
    normalizeOptionalString(identityRecord.icon_emoji) ??
    normalizeOptionalString(identityRecord.iconEmoji);
  if (!username && !iconUrl && !iconEmoji) {
    return undefined;
  }
  return {
    ...(username ? { username } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(iconEmoji ? { iconEmoji } : {}),
  };
}

function sendRelayAck(ws: WebSocket, envelopeId: string | undefined): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "ack",
      envelope_id: envelopeId,
    }),
  );
}

function closeRelayWebSocket(ws: WebSocket | undefined): void {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    return;
  }
  ws.close();
}

function formatRelayClose(code: number, reason: Buffer): string {
  const text = reason.toString("utf8");
  return text
    ? `Slack relay websocket closed (${code} ${text})`
    : `Slack relay websocket closed (${code})`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
