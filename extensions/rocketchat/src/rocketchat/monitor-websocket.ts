import type { ChannelAccountSnapshot, RuntimeEnv } from "openclaw/plugin-sdk";
import WebSocket from "ws";
import type { RocketchatMessage } from "./client.js";
import { rawDataToString } from "./monitor-helpers.js";

/**
 * Rocket.Chat uses a DDP-like protocol over WebSocket.
 * Messages are JSON objects with an `msg` field indicating the message type.
 * For real-time messages, we subscribe to `stream-room-messages`.
 */
export type RocketchatWsPayload = {
  msg?: string;
  id?: string;
  collection?: string;
  fields?: {
    eventName?: string;
    args?: RocketchatMessage[];
  };
  result?: unknown;
  error?: { error: string; message?: string };
  session?: string;
};

export type RocketchatWebSocketLike = {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: WebSocket.RawData) => void | Promise<void>): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  send(data: string): void;
  close(): void;
  terminate(): void;
};

export type RocketchatWebSocketFactory = (url: string) => RocketchatWebSocketLike;

export class WebSocketClosedBeforeOpenError extends Error {
  constructor(
    public readonly code: number,
    public readonly reason?: string,
  ) {
    super(`websocket closed before open (code ${code})`);
    this.name = "WebSocketClosedBeforeOpenError";
  }
}

type CreateRocketchatConnectOnceOpts = {
  wsUrl: string;
  authToken: string;
  userId: string;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  runtime: RuntimeEnv;
  nextId: () => string;
  roomIds: string[];
  onMessage: (message: RocketchatMessage, roomId: string) => Promise<void>;
  webSocketFactory?: RocketchatWebSocketFactory;
};

export const defaultRocketchatWebSocketFactory: RocketchatWebSocketFactory = (url) =>
  new WebSocket(url) as RocketchatWebSocketLike;

export function parseStreamMessage(
  data: WebSocket.RawData,
): { message: RocketchatMessage; roomId: string } | null {
  const raw = rawDataToString(data);
  let payload: RocketchatWsPayload;
  try {
    payload = JSON.parse(raw) as RocketchatWsPayload;
  } catch {
    return null;
  }
  if (payload.msg !== "changed" || payload.collection !== "stream-room-messages") {
    return null;
  }
  const args = payload.fields?.args;
  if (!args || !Array.isArray(args) || args.length === 0) {
    return null;
  }
  const message = args[0];
  if (!message?._id) {
    return null;
  }
  const roomId = payload.fields?.eventName ?? message.rid ?? "";
  return { message, roomId };
}

export function createRocketchatConnectOnce(
  opts: CreateRocketchatConnectOnceOpts,
): () => Promise<void> {
  const webSocketFactory = opts.webSocketFactory ?? defaultRocketchatWebSocketFactory;
  return async () => {
    const ws = webSocketFactory(opts.wsUrl);
    const onAbort = () => ws.terminate();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

    let pingInterval: NodeJS.Timeout | null = null;

    try {
      return await new Promise<void>((resolve, reject) => {
        let opened = false;
        let settled = false;
        const resolveOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          if (pingInterval) {
            clearInterval(pingInterval);
          }
          resolve();
        };
        const rejectOnce = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (pingInterval) {
            clearInterval(pingInterval);
          }
          reject(error);
        };

        ws.on("open", () => {
          opened = true;
          opts.statusSink?.({
            connected: true,
            lastConnectedAt: Date.now(),
            lastError: null,
          });
          // DDP connect
          ws.send(
            JSON.stringify({
              msg: "connect",
              version: "1",
              support: ["1"],
            }),
          );
        });

        ws.on("message", async (data) => {
          const raw = rawDataToString(data);
          let payload: RocketchatWsPayload;
          try {
            payload = JSON.parse(raw) as RocketchatWsPayload;
          } catch {
            return;
          }

          // Handle DDP pong
          if (payload.msg === "ping") {
            ws.send(JSON.stringify({ msg: "pong" }));
            return;
          }

          // After connected, authenticate and subscribe
          if (payload.msg === "connected") {
            // Login with auth token
            const loginId = opts.nextId();
            ws.send(
              JSON.stringify({
                msg: "method",
                method: "login",
                id: loginId,
                params: [{ resume: opts.authToken }],
              }),
            );

            // Subscribe to each room's messages
            for (const roomId of opts.roomIds) {
              const subId = opts.nextId();
              ws.send(
                JSON.stringify({
                  msg: "sub",
                  id: subId,
                  name: "stream-room-messages",
                  params: [roomId, false],
                }),
              );
            }

            // Start periodic pings
            pingInterval = setInterval(() => {
              ws.send(JSON.stringify({ msg: "ping" }));
            }, 25_000);
            return;
          }

          // Handle incoming messages
          const parsed = parseStreamMessage(data);
          if (parsed) {
            try {
              await opts.onMessage(parsed.message, parsed.roomId);
            } catch (err) {
              opts.runtime.error?.(`rocketchat handler failed: ${String(err)}`);
            }
          }
        });

        ws.on("close", (code, reason) => {
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
          opts.runtime.error?.(`rocketchat websocket error: ${String(err)}`);
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
      if (pingInterval) {
        clearInterval(pingInterval);
      }
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
