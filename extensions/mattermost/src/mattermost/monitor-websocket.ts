import { safeParseJsonWithSchema, safeParseWithSchema } from "openclaw/plugin-sdk/extension-shared";
import WebSocket from "ws";
import { z } from "zod";
import type { ChannelAccountSnapshot, RuntimeEnv } from "../runtime-api.js";
import type { MattermostPost } from "./client.js";
import { rawDataToString } from "./monitor-helpers.js";

export type MattermostEventPayload = {
  event?: string;
  data?: {
    post?: string | MattermostPost;
    reaction?: string | Record<string, unknown>;
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

const MattermostPostSchema = z.record(
  z.string(),
  z.unknown(),
) as unknown as z.ZodType<MattermostPost>;

const MattermostEventPayloadSchema = z.object({
  event: z.string().optional(),
  data: z
    .object({
      post: z.union([z.string(), MattermostPostSchema]).optional(),
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
}) as z.ZodType<MattermostEventPayload>;

function parseMattermostEventPayload(raw: string): MattermostEventPayload | null {
  return safeParseJsonWithSchema(MattermostEventPayloadSchema, raw);
}

function parseMattermostPost(value: unknown): MattermostPost | null {
  if (typeof value === "string") {
    return safeParseJsonWithSchema(MattermostPostSchema, value);
  }
  return safeParseWithSchema(MattermostPostSchema, value);
}

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
  const post = parseMattermostPost(postData);
  if (!post) {
    return null;
  }
  return { payload, post };
}

export function parsePostedEvent(
  data: WebSocket.RawData,
): { payload: MattermostEventPayload; post: MattermostPost } | null {
  const raw = rawDataToString(data);
  const payload = parseMattermostEventPayload(raw);
  if (!payload) {
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
          const raw = rawDataToString(data);
          const payload = parseMattermostEventPayload(raw);
          if (!payload) {
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
