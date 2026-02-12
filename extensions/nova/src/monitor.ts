import { format } from "node:util";
import {
  createReplyPrefixContext,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import WebSocket from "ws";
import type { NovaConfig } from "./types.js";
import { setActiveNovaConnection } from "./connection.js";
import { resolveNovaCredentials } from "./credentials.js";
import { parseNovaInboundMessage } from "./inbound.js";
import { getNovaRuntime } from "./runtime.js";
import { sendNovaMessage } from "./send.js";

export type MonitorNovaOpts = {
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

const DEFAULT_RECONNECT_BASE_MS = 1000;
const MAX_RECONNECT_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * Persistent WebSocket client that connects to the Nova backend,
 * receives inbound messages, dispatches them through the agent pipeline,
 * and reconnects with exponential backoff on failure.
 */
export async function monitorNovaProvider(opts: MonitorNovaOpts): Promise<void> {
  const core = getNovaRuntime();
  const cfg = opts.cfg;
  const novaCfg = cfg.channels?.nova as NovaConfig | undefined;

  if (novaCfg?.enabled === false) {
    return;
  }

  const creds = resolveNovaCredentials(novaCfg);
  if (!creds) {
    throw new Error("Nova credentials not configured (apiKey, userId)");
  }

  const logger = core.logging.getChildLogger({ module: "nova-monitor" });
  const formatRuntimeMessage = (...args: Parameters<RuntimeEnv["log"]>) => format(...args);
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args) => logger.info(formatRuntimeMessage(...args)),
    error: (...args) => logger.error(formatRuntimeMessage(...args)),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const reconnectBaseMs = novaCfg?.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_MS;
  const heartbeatIntervalMs = novaCfg?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const _textLimit = core.channel.text.resolveTextChunkLimit(cfg, "nova");

  let attempt = 0;

  await new Promise<void>((resolveMonitor) => {
    if (opts.abortSignal?.aborted) {
      resolveMonitor();
      return;
    }

    const onAbort = () => {
      logger.info("nova: abort signal received, closing connection");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearHeartbeat();
      const ws = activeWs;
      activeWs = null;
      setActiveNovaConnection(null);
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close(1000, "shutdown");
      }
      resolveMonitor();
    };

    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

    let activeWs: WebSocket | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function clearHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    function startHeartbeat(ws: WebSocket) {
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "ping", timestamp: Date.now() }));
        }
      }, heartbeatIntervalMs);
    }

    function scheduleReconnect() {
      if (opts.abortSignal?.aborted) {
        resolveMonitor();
        return;
      }
      attempt++;
      const jitter = Math.random() * 0.3 + 0.85; // 0.85..1.15
      const delay = Math.min(reconnectBaseMs * 2 ** attempt * jitter, MAX_RECONNECT_MS);
      logger.info(`nova: reconnecting in ${Math.round(delay)}ms (attempt ${attempt})`);
      reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
      if (opts.abortSignal?.aborted) {
        resolveMonitor();
        return;
      }

      const url = `${creds.baseUrl}?userId=${encodeURIComponent(creds.userId)}&deviceId=${encodeURIComponent(creds.deviceId)}`;
      logger.info(`nova: connecting to ${creds.baseUrl}`);

      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${creds.apiKey}` },
      });
      activeWs = ws;

      ws.on("open", () => {
        logger.info("nova: WebSocket connected");
        setActiveNovaConnection(ws);
        attempt = 0;
        startHeartbeat(ws);
      });

      ws.on("message", (data: WebSocket.RawData) => {
        const raw = typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
        handleInboundMessage(raw, cfg, runtime).catch((err) => {
          runtime.error?.(`nova: dispatch error: ${String(err)}`);
        });
      });

      ws.on("close", (code, reason) => {
        logger.info(`nova: WebSocket closed (code=${code}, reason=${reason.toString("utf8")})`);
        clearHeartbeat();
        setActiveNovaConnection(null);
        activeWs = null;
        scheduleReconnect();
      });

      ws.on("error", (err) => {
        logger.error(`nova: WebSocket error: ${String(err)}`);
        // 'close' event will follow; reconnect handled there
      });
    }

    async function handleInboundMessage(
      raw: string,
      msgCfg: OpenClawConfig,
      msgRuntime: RuntimeEnv,
    ): Promise<void> {
      const msg = parseNovaInboundMessage(raw);
      if (!msg) {
        // Ignore non-message frames (pong, ack, etc.)
        return;
      }

      const dmPolicy = novaCfg?.dmPolicy ?? "allowlist";
      const allowFrom = (novaCfg?.allowFrom ?? []).map((entry) =>
        String(entry).trim().toLowerCase(),
      );

      // Enforce allowlist policy — an empty allowlist blocks everyone
      if (dmPolicy === "allowlist" && !allowFrom.includes("*")) {
        if (allowFrom.length === 0) {
          logger.info(`nova: message from ${msg.userId} dropped (allowlist is empty)`);
          return;
        }
        const senderId = msg.userId.trim().toLowerCase();
        if (!allowFrom.includes(senderId)) {
          logger.info(`nova: message from ${msg.userId} dropped (not in allowlist)`);
          return;
        }
      }

      const novaFrom = `nova:${msg.userId}`;
      const novaTo = `nova:${creds.userId}`;

      const route = core.channel.routing.resolveAgentRoute({
        cfg: msgCfg,
        channel: "nova",
        accountId: DEFAULT_ACCOUNT_ID,
        peer: { kind: "user", id: msg.userId },
      });

      const storePath = core.config.resolveStorePath(route.agentId);

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: msg.text,
        RawBody: msg.text,
        CommandBody: msg.text,
        From: novaFrom,
        To: novaTo,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: "direct" as const,
        ConversationLabel: novaFrom,
        SenderName: msg.userId,
        SenderId: msg.userId,
        Provider: "nova" as const,
        Surface: "nova" as const,
        MessageSid: msg.messageId,
        Timestamp: msg.timestamp,
        WasMentioned: true, // DMs are always "mentioned"
        CommandAuthorized: true,
        OriginatingChannel: "nova" as const,
        OriginatingTo: novaTo,
      });

      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err) => {
          logger.debug(`nova: failed updating session meta: ${String(err)}`);
        },
      });

      logger.info(`nova inbound: from=${msg.userId} preview="${msg.text.slice(0, 60)}"`);

      const prefixContext = createReplyPrefixContext({
        cfg: msgCfg,
        agentId: route.agentId,
      });

      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          responsePrefix: prefixContext.responsePrefix,
          responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(msgCfg, route.agentId),
          deliver: async (payload) => {
            const chunks = payload.parts ?? [];
            const fullText = chunks
              .map((part) => (typeof part === "string" ? part : (part.text ?? "")))
              .join("");
            if (!fullText.trim()) {
              return;
            }
            await sendNovaMessage({
              cfg: msgCfg,
              to: msg.userId,
              text: fullText,
              replyTo: msg.messageId,
              done: true,
            });
          },
          onError: (err, info) => {
            msgRuntime.error?.(`nova ${info.kind} reply failed: ${String(err)}`);
          },
        });

      try {
        const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg: msgCfg,
          dispatcher,
          replyOptions: { ...replyOptions, onModelSelected: prefixContext.onModelSelected },
        });
        markDispatchIdle();
        logger.info(`nova: dispatch complete (queuedFinal=${queuedFinal}, final=${counts.final})`);
      } catch (err) {
        logger.error(`nova: dispatch failed: ${String(err)}`);
        msgRuntime.error?.(`nova dispatch failed: ${String(err)}`);
      }
    }

    // Start the first connection attempt
    connect();
  });
}
