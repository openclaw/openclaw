import { randomUUID } from "node:crypto";
import { safeParseJsonWithSchema, safeParseWithSchema } from "openclaw/plugin-sdk/extension-shared";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import {
  captureWsEventAsync,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { type RawData, WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { z } from "zod";
import { MattermostPostSchema, type MattermostPost } from "./client.js";
import type { ChannelAccountSnapshot, RuntimeEnv } from "./runtime-api.js";

export type MattermostEventPayload = z.infer<typeof MattermostEventPayloadSchema>;

// Mattermost events can include double-encoded post props plus server/plugin metadata.
// Keep channel-compatible headroom while bounding ws's 100 MiB default before parsing.
const MATTERMOST_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
// A TCP peer can accept without completing the HTTP upgrade; ws has no default deadline.
const MATTERMOST_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 30_000;
// After the challenge the server contract is reply-OK or close; this bounds a
// peer that does neither so the channel cannot sit unauthenticated forever.
const MATTERMOST_WEBSOCKET_AUTH_TIMEOUT_MS = 30_000;
const MATTERMOST_WEBSOCKET_HEALTH_CHECK_INTERVAL_MS = 30_000;
const MATTERMOST_WEBSOCKET_PING_INTERVAL_MS = 30_000;
const MATTERMOST_WEBSOCKET_PONG_TIMEOUT_MS = 10_000;
const MattermostEventPayloadSchema = z.object({
  event: z.string().optional(),
  status: z.string().optional(),
  seq_reply: z.number().optional(),
  data: z
    .object({
      // Durable ingress validates the post only after claiming the raw envelope.
      post: z.unknown().optional(),
      reaction: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      channel_id: z.string().optional(),
      channel_name: z.string().optional(),
      channel_display_name: z.string().optional(),
      channel_type: z.string().optional(),
      sender_name: z.string().optional(),
      team_id: z.string().optional(),
    })
    .optional(),
  broadcast: z
    .object({
      channel_id: z.string().optional(),
      team_id: z.string().optional(),
      user_id: z.string().optional(),
    })
    .optional(),
});

export function parseMattermostEventPayload(raw: string): MattermostEventPayload | null {
  return safeParseJsonWithSchema(MattermostEventPayloadSchema, raw);
}

export function parseMattermostPost(value: unknown): MattermostPost | null {
  if (typeof value === "string") {
    return safeParseJsonWithSchema(MattermostPostSchema, value);
  }
  return safeParseWithSchema(MattermostPostSchema, value);
}

type CreateMattermostConnectOnceOpts = {
  wsUrl: string;
  botToken: string;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  runtime: RuntimeEnv;
  nextSeq: () => number;
  onPosted: (rawEvent: string) => Promise<void>;
  onReaction?: (payload: MattermostEventPayload) => Promise<void>;
  /**
   * Called periodically to check whether the bot account has been modified
   * (e.g. disabled then re-enabled) since the WebSocket was opened.
   * Returns the bot's current `update_at` timestamp.  When it differs from
   * the value recorded at connect time, the connection is terminated so the
   * reconnect loop can establish a fresh one.
   */
  getBotUpdateAt?: () => Promise<number>;
};

export function createMattermostConnectOnce(
  opts: CreateMattermostConnectOnceOpts,
): () => Promise<void> {
  return async () => {
    const flowId = randomUUID();
    const captureEvent = (
      event: Omit<Parameters<typeof captureWsEventAsync>[0], "url" | "flowId">,
    ) => {
      // Capture finalization owns failures; observe this connection's asynchronous writes.
      void captureWsEventAsync({
        ...event,
        url: opts.wsUrl,
        flowId,
        meta: { subsystem: "mattermost-websocket", ...event.meta },
      }).catch(() => {});
    };
    const agent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
    const ws = new WebSocket(opts.wsUrl, {
      maxPayload: MATTERMOST_WEBSOCKET_MAX_PAYLOAD_BYTES,
      handshakeTimeout: MATTERMOST_WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    });
    const onAbort = () => ws.terminate();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const getBotUpdateAt = opts.getBotUpdateAt;

    try {
      return await new Promise<void>((resolve, reject) => {
        let opened = false;
        let authenticated = false;
        let stopped = false;
        let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;
        let protocolPingTimer: ReturnType<typeof setTimeout> | undefined;
        let protocolPongTimer: ReturnType<typeof setTimeout> | undefined;
        let initialUpdateAt: number | undefined;
        let authenticationSeq: number | undefined;
        let authTimer: ReturnType<typeof setTimeout> | undefined;

        const stopHealthChecks = () => {
          stopped = true;
          clearTimeout(healthCheckTimer);
          clearTimeout(authTimer);
          clearTimeout(protocolPingTimer);
          clearTimeout(protocolPongTimer);
        };

        const sendProtocolPing = () => {
          if (stopped) {
            return;
          }
          clearTimeout(protocolPongTimer);
          protocolPongTimer = setTimeout(() => {
            protocolPongTimer = undefined;
            opts.runtime.error?.("mattermost websocket pong timeout — reconnecting");
            stopHealthChecks();
            ws.terminate();
          }, MATTERMOST_WEBSOCKET_PONG_TIMEOUT_MS);
          try {
            ws.ping();
          } catch (err) {
            opts.runtime.error?.(`mattermost websocket ping failed: ${String(err)}`);
            stopHealthChecks();
            ws.terminate();
          }
        };

        const scheduleProtocolPing = () => {
          if (stopped || protocolPingTimer !== undefined) {
            return;
          }
          protocolPingTimer = setTimeout(() => {
            protocolPingTimer = undefined;
            sendProtocolPing();
          }, MATTERMOST_WEBSOCKET_PING_INTERVAL_MS);
        };

        const scheduleHealthCheck = () => {
          if (!getBotUpdateAt || stopped) {
            return;
          }
          healthCheckTimer = setTimeout(() => {
            healthCheckTimer = undefined;
            void runHealthCheck();
          }, MATTERMOST_WEBSOCKET_HEALTH_CHECK_INTERVAL_MS);
        };

        const runHealthCheck = async () => {
          if (!getBotUpdateAt || stopped) {
            return;
          }
          try {
            const current = await getBotUpdateAt();
            if (stopped) {
              return;
            }
            if (initialUpdateAt === undefined) {
              initialUpdateAt = current;
              return;
            }
            if (current !== initialUpdateAt) {
              opts.runtime.log?.(
                `mattermost: bot account updated (update_at changed: ${initialUpdateAt} → ${current}) — reconnecting`,
              );
              stopHealthChecks();
              ws.terminate();
            }
          } catch (err) {
            if (stopped) {
              return;
            }
            const label =
              initialUpdateAt === undefined
                ? "mattermost: failed to get initial update_at"
                : "mattermost: health check error";
            opts.runtime.error?.(`${label}: ${String(err)}`);
          } finally {
            scheduleHealthCheck();
          }
        };

        ws.on("open", () => {
          opened = true;
          captureEvent({
            direction: "local",
            kind: "ws-open",
          });
          opts.statusSink?.({
            connected: true,
            lifecycle: "starting",
          });
          authenticationSeq = opts.nextSeq();
          const authPayload = JSON.stringify({
            seq: authenticationSeq,
            action: "authentication_challenge",
            data: { token: opts.botToken },
          });
          captureEvent({
            direction: "outbound",
            kind: "ws-frame",
            payload: authPayload,
            meta: { eventType: "authentication_challenge" },
          });
          ws.send(authPayload);
          authTimer = setTimeout(() => {
            authTimer = undefined;
            opts.runtime.error?.("mattermost websocket authentication timed out — reconnecting");
            stopHealthChecks();
            ws.terminate();
          }, MATTERMOST_WEBSOCKET_AUTH_TIMEOUT_MS);
          scheduleProtocolPing();

          // Periodically check if the bot account was modified (e.g. disable/enable).
          // After such a cycle the WebSocket silently stops delivering events even
          // though the connection itself stays alive.  Comparing update_at detects
          // this reliably regardless of how quickly the cycle happens.
          if (getBotUpdateAt) {
            // Use a recursive timeout so only one REST poll can be in flight at a time.
            void runHealthCheck();
          }
        });

        ws.on("pong", () => {
          clearTimeout(protocolPongTimer);
          protocolPongTimer = undefined;
          scheduleProtocolPing();
        });

        const onMessage = async (data: RawData) => {
          const raw = rawDataToString(data);
          captureEvent({
            direction: "inbound",
            kind: "ws-frame",
            payload: Buffer.from(raw),
          });
          const payload = parseMattermostEventPayload(raw);
          if (!payload) {
            return;
          }

          if (payload.status === "OK" && payload.seq_reply === authenticationSeq) {
            authenticated = true;
            clearTimeout(authTimer);
            authTimer = undefined;
            opts.statusSink?.(channelReadyPatch());
            return;
          }

          if (payload.event === "reaction_added" || payload.event === "reaction_removed") {
            if (!opts.onReaction) {
              return;
            }
            try {
              await opts.onReaction(payload);
            } catch (err) {
              opts.runtime.error?.(`mattermost reaction handler failed: ${String(err)}`);
            }
            return;
          }

          if (payload.event !== "posted") {
            return;
          }
          try {
            await opts.onPosted(raw);
          } catch (err) {
            // Durable admission failed after retries: this post is lost and the
            // websocket cannot nack or replay. Tear the connection down loudly
            // so the outage is operator-visible instead of silently dropping
            // every subsequent post against a broken store.
            opts.runtime.error?.(
              `mattermost durable admission failed; terminating websocket: ${String(err)}`,
            );
            ws.terminate();
          }
        };
        ws.on("message", (data) => {
          void onMessage(data);
        });

        ws.on("close", (code, reason) => {
          captureEvent({
            direction: "local",
            kind: "ws-close",
            closeCode: code,
            payload: reason,
          });
          stopHealthChecks();
          const message = reason.toString("utf8");
          opts.statusSink?.({
            connected: false,
            lifecycle: "recovering",
            lastDisconnect: {
              at: Date.now(),
              status: code,
              error: message || undefined,
            },
          });
          if (opened && authenticated) {
            resolve();
            return;
          }
          // A rejected token and a transient drop share the pre-auth close shape.
          // Reject either phase so reconnect backoff and visible failure reporting apply.
          const error = new Error(
            opened
              ? `websocket closed before authentication completed (code ${code}) — either the bot token was rejected or the connection dropped (server restart, proxy reset); check the Mattermost bot token if this repeats`
              : `websocket closed before open (code ${code})`,
          );
          reject(
            Object.assign(error, {
              code,
              reason: message || undefined,
              name: opened
                ? "WebSocketClosedBeforeAuthenticationError"
                : "WebSocketClosedBeforeOpenError",
            }),
          );
        });

        ws.on("error", (err) => {
          captureEvent({
            direction: "local",
            kind: "error",
            errorText: String(err),
          });
          opts.runtime.error?.(`mattermost websocket error: ${String(err)}`);
          opts.statusSink?.({
            connected: false,
            lifecycle: "recovering",
            lastError: String(err),
          });
          try {
            ws.close();
          } catch {
            // The transport error is already reported; closing a broken socket is best effort.
          }
        });
      });
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
    }
  };
}
