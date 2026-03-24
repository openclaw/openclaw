import WebSocket from "ws";
import type { ChannelAccountSnapshot, RuntimeEnv } from "../runtime-api.js";
import type { MattermostPost } from "./client.js";
import { rawDataToString } from "./monitor-helpers.js";

export type MattermostEventPayload = {
  event?: string;
  data?: {
    post?: string;
    reaction?: string;
    channel_id?: string;
    channel_name?: string;
    channel_display_name?: string;
    channel_type?: string;
    sender_name?: string;
    team_id?: string;
  };
  broadcast?: {
    channel_id?: string;
    team_id?: string;
    user_id?: string;
  };
};

export type MattermostWebSocketLike = {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: WebSocket.RawData) => void | Promise<void>): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  send(data: string): void;
  close(): void;
  terminate(): void;
};

export type MattermostWebSocketFactory = (url: string) => MattermostWebSocketLike;

export class WebSocketClosedBeforeOpenError extends Error {
  constructor(
    public readonly code: number,
    public readonly reason?: string,
  ) {
    super(`websocket closed before open (code ${code})`);
    this.name = "WebSocketClosedBeforeOpenError";
  }
}

type CreateMattermostConnectOnceOpts = {
  wsUrl: string;
  botToken: string;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  runtime: RuntimeEnv;
  nextSeq: () => number;
  onPosted: (post: MattermostPost, payload: MattermostEventPayload) => Promise<void>;
  onReaction?: (payload: MattermostEventPayload) => Promise<void>;
  webSocketFactory?: MattermostWebSocketFactory;
  /**
   * Called periodically to check whether the bot account has been modified
   * (e.g. disabled then re-enabled) since the WebSocket was opened.
   * Returns the bot's current `update_at` timestamp.  When it differs from
   * the value recorded at connect time, the connection is terminated so the
   * reconnect loop can establish a fresh one.
   */
  getBotUpdateAt?: () => Promise<number>;
  healthCheckIntervalMs?: number;
};

export const defaultMattermostWebSocketFactory: MattermostWebSocketFactory = (url) =>
  new WebSocket(url) as MattermostWebSocketLike;

export function parsePostedPayload(
  payload: MattermostEventPayload,
): { payload: MattermostEventPayload; post: MattermostPost } | null {
  if (payload.event !== "posted") {
    return null;
  }
  const postData = payload.data?.post;
  if (!postData) {
    return null;
  }
  let post: MattermostPost | null = null;
  if (typeof postData === "string") {
    try {
      post = JSON.parse(postData) as MattermostPost;
    } catch {
      return null;
    }
  } else if (typeof postData === "object") {
    post = postData as MattermostPost;
  }
  if (!post) {
    return null;
  }
  return { payload, post };
}

export function parsePostedEvent(
  data: WebSocket.RawData,
): { payload: MattermostEventPayload; post: MattermostPost } | null {
  const raw = rawDataToString(data);
  let payload: MattermostEventPayload;
  try {
    payload = JSON.parse(raw) as MattermostEventPayload;
  } catch {
    return null;
  }
  return parsePostedPayload(payload);
}

export function createMattermostConnectOnce(
  opts: CreateMattermostConnectOnceOpts,
): () => Promise<void> {
  const webSocketFactory = opts.webSocketFactory ?? defaultMattermostWebSocketFactory;
  const healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 30_000;
  return async () => {
    const ws = webSocketFactory(opts.wsUrl);
    const onAbort = () => ws.terminate();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      return await new Promise<void>((resolve, reject) => {
        let opened = false;
        let settled = false;
        let healthCheckTimer: ReturnType<typeof setInterval> | undefined;
        let initialUpdateAt: number | undefined;

        const clearTimers = () => {
          if (healthCheckTimer !== undefined) {
            clearInterval(healthCheckTimer);
            healthCheckTimer = undefined;
          }
        };

        const resolveOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimers();
          resolve();
        };
        const rejectOnce = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimers();
          reject(error);
        };

        ws.on("open", () => {
          opened = true;
          opts.statusSink?.({
            connected: true,
            lastConnectedAt: Date.now(),
            lastError: null,
          });
          ws.send(
            JSON.stringify({
              seq: opts.nextSeq(),
              action: "authentication_challenge",
              data: { token: opts.botToken },
            }),
          );

          // Periodically check if the bot account was modified (e.g. disable/enable).
          // After such a cycle the WebSocket silently stops delivering events even
          // though the connection itself stays alive.  Comparing update_at detects
          // this reliably regardless of how quickly the cycle happens.
          if (opts.getBotUpdateAt) {
            const getBotUpdateAt = opts.getBotUpdateAt;
            // Capture initial update_at, then start polling.
            getBotUpdateAt()
              .then((ts) => {
                initialUpdateAt = ts;
                healthCheckTimer = setInterval(() => {
                  getBotUpdateAt()
                    .then((current) => {
                      if (initialUpdateAt !== undefined && current !== initialUpdateAt) {
                        opts.runtime.log?.(
                          `mattermost: bot account updated (update_at changed: ${initialUpdateAt} → ${current}) — reconnecting`,
                        );
                        ws.terminate();
                      }
                    })
                    .catch((err) => {
                      opts.runtime.error?.(`mattermost: health check error: ${String(err)}`);
                    });
                }, healthCheckIntervalMs);
              })
              .catch((err) => {
                opts.runtime.error?.(`mattermost: failed to get initial update_at: ${String(err)}`);
              });
          }
        });

        ws.on("message", async (data) => {
          const raw = rawDataToString(data);
          let payload: MattermostEventPayload;
          try {
            payload = JSON.parse(raw) as MattermostEventPayload;
          } catch {
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
          const parsed = parsePostedPayload(payload);
          if (!parsed) {
            return;
          }
          try {
            await opts.onPosted(parsed.post, parsed.payload);
          } catch (err) {
            opts.runtime.error?.(`mattermost handler failed: ${String(err)}`);
          }
        });

        ws.on("close", (code, reason) => {
          clearTimers();
          const message = reasonToString(reason);
          opts.statusSink?.({
            connected: false,
            lastDisconnect: {
              at: Date.now(),
              status: code,
              error: message || undefined,
            },
          });
          if (opened) {
            resolveOnce();
            return;
          }
          rejectOnce(new WebSocketClosedBeforeOpenError(code, message || undefined));
        });

        ws.on("error", (err) => {
          opts.runtime.error?.(`mattermost websocket error: ${String(err)}`);
          opts.statusSink?.({
            lastError: String(err),
          });
          try {
            ws.close();
          } catch {}
        });
      });
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
    }
  };
}

function reasonToString(reason: Buffer | string | undefined): string {
  if (!reason) {
    return "";
  }
  if (typeof reason === "string") {
    return reason;
  }
  return reason.length > 0 ? reason.toString("utf8") : "";
}
