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
  on(event: "ping", listener: (data: Buffer) => void): void;
  on(event: "pong", listener: (data: Buffer) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  send(data: string): void;
  ping(): void;
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
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
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
  return async () => {
    const ws = webSocketFactory(opts.wsUrl);
    const onAbort = () => ws.terminate();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const heartbeatIntervalMs = Math.max(1, opts.heartbeatIntervalMs ?? 30_000);
    const heartbeatTimeoutMs = Math.max(
      heartbeatIntervalMs * 2,
      opts.heartbeatTimeoutMs ?? heartbeatIntervalMs * 3,
    );
    let lastActivityAt = Date.now();
    let inFlightHandlerCount = 0;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const noteActivity = () => {
      lastActivityAt = Date.now();
    };
    const cleanupHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    const startHeartbeat = () => {
      cleanupHeartbeat();
      heartbeatTimer = setInterval(() => {
        const idleMs = Date.now() - lastActivityAt;
        if (idleMs > heartbeatTimeoutMs && inFlightHandlerCount === 0) {
          const message = `mattermost websocket heartbeat timed out after ${Math.round(idleMs / 1000)}s`;
          opts.runtime.error?.(message);
          opts.statusSink?.({ lastError: message });
          cleanupHeartbeat();
          try {
            ws.terminate();
          } catch {}
          return;
        }
        try {
          ws.ping();
        } catch (err) {
          const message = `mattermost websocket heartbeat ping failed: ${String(err)}`;
          opts.runtime.error?.(message);
          opts.statusSink?.({ lastError: message });
          cleanupHeartbeat();
          try {
            ws.terminate();
          } catch {}
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    };

    const withInFlightHandler = async <T>(handler: () => Promise<T>): Promise<T> => {
      inFlightHandlerCount++;
      noteActivity();
      try {
        return await handler();
      } finally {
        inFlightHandlerCount = Math.max(0, inFlightHandlerCount - 1);
        noteActivity();
      }
    };

    try {
      return await new Promise<void>((resolve, reject) => {
        let opened = false;
        let settled = false;
        const resolveOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };
        const rejectOnce = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        };

        ws.on("open", () => {
          opened = true;
          noteActivity();
          startHeartbeat();
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
        });

        ws.on("message", async (data) => {
          noteActivity();
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
              await withInFlightHandler(() => opts.onReaction!(payload));
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
            await withInFlightHandler(() => opts.onPosted(parsed.post, parsed.payload));
          } catch (err) {
            opts.runtime.error?.(`mattermost handler failed: ${String(err)}`);
          }
        });

        ws.on("ping", () => {
          noteActivity();
        });

        ws.on("pong", () => {
          noteActivity();
        });

        ws.on("close", (code, reason) => {
          cleanupHeartbeat();
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
          cleanupHeartbeat();
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
      cleanupHeartbeat();
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
