import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import WebSocket from "ws";
import { z } from "zod";

const recordedKinds: Record<string, true> = {
  MESSAGE_CREATE: true,
  MESSAGE_UPDATE: true,
  MESSAGE_DELETE: true,
  MESSAGE_DELETE_BULK: true,
  MESSAGE_REACTION_ADD: true,
  MESSAGE_REACTION_REMOVE: true,
  MESSAGE_REACTION_REMOVE_ALL: true,
  MESSAGE_REACTION_REMOVE_EMOJI: true,
  TYPING_START: true,
};

const dispatchSchema = z.object({
  op: z.number(),
  s: z.number().nullable().optional(),
  t: z.string().nullable().optional(),
  d: z.unknown(),
});
const eventSchema = z.object({
  id: z.string().optional(),
  ids: z.array(z.string()).optional(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  author: z.object({ id: z.string(), bot: z.boolean().optional() }).optional(),
  user_id: z.string().optional(),
  message_id: z.string().optional(),
  content: z.string().nullable().optional(),
  message_reference: z.object({ message_id: z.string().optional() }).optional(),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        filename: z.string().optional(),
        content_type: z.string().optional(),
      }),
    )
    .optional(),
  embeds: z.array(z.unknown()).optional(),
  components: z.array(z.unknown()).optional(),
  emoji: z
    .object({ id: z.string().nullable().optional(), name: z.string().nullable().optional() })
    .optional(),
});
export type DiscordE2eNativeMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: { id: string; bot?: boolean };
  content?: string | null;
  message_reference?: { message_id?: string };
  attachments?: Array<{ id: string; filename?: string; content_type?: string; url?: string }>;
};

type RecordedMessage = DiscordE2eNativeMessage & { deleted?: boolean };

/** A fail-closed observation session, not an owner of the QA lease or SUT Gateway. */
export function createDiscordE2eRecorder(params: {
  token: string;
  guildId: string;
  channelId: string;
  driverId: string;
  sutId: string;
  signal?: AbortSignal;
  assertActive: () => void;
  record: (event: Record<string, unknown>) => void;
}) {
  const channels = new Set([params.channelId]);
  const messages = new Map<string, RecordedMessage>();
  const driven = new Set<string>();
  const correlations = new Map<string, string>();
  let socket: WebSocket | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let failure: Error | undefined;
  let closed = false;
  let sequence: number | null = null;
  let awaitingAck = false;
  let ready: Promise<void> | undefined;
  let rejectReady: ((error: Error) => void) | undefined;

  const stop = () => {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abort);
    socket?.terminate();
  };
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error("Discord recorder failed");
    rejectReady?.(failure);
    stop();
  };
  const abort = () => fail(new Error("Discord recorder cancelled"));
  const actor = (id?: string) =>
    id === params.sutId ? "sut" : id === params.driverId ? "driver" : "other";

  function ingest(kind: string, raw: unknown) {
    const data = eventSchema.parse(raw);
    if (!channels.has(data.channel_id) || (data.guild_id && data.guild_id !== params.guildId)) {
      return;
    }
    const ids = kind === "MESSAGE_DELETE_BULK" ? (data.ids ?? []) : [data.id ?? data.message_id];
    for (const id of ids) {
      const previous = id ? messages.get(id) : undefined;
      const isMessage = kind === "MESSAGE_CREATE" || kind === "MESSAGE_UPDATE";
      const isDelete = kind === "MESSAGE_DELETE" || kind === "MESSAGE_DELETE_BULK";
      const authorId = isMessage
        ? (data.author?.id ?? previous?.author?.id)
        : isDelete
          ? previous?.author?.id
          : data.user_id;
      // Do not retain unrelated authors' message content from a shared guild channel.
      if (isMessage && actor(authorId) === "other") {
        continue;
      }
      const message =
        isMessage && id
          ? {
              ...previous,
              id,
              channel_id: data.channel_id,
              guild_id: data.guild_id,
              author: data.author ?? previous?.author,
              content: data.content === undefined ? previous?.content : data.content,
              attachments: data.attachments ?? previous?.attachments,
              message_reference: data.message_reference ?? previous?.message_reference,
            }
          : previous;
      if (message && id && isMessage) {
        if (messages.size >= 20_000 && !messages.has(id)) {
          throw new Error("Discord recorder message limit reached; evidence is incomplete");
        }
        messages.set(id, message);
      }
      const replyTo = message?.message_reference?.message_id;
      if (id && authorId === params.sutId && replyTo && driven.has(replyTo)) {
        correlations.set(id, replyTo);
      }
      params.record({
        source: "discord-gateway",
        kind,
        sequence,
        channelId: data.channel_id,
        messageId: id,
        actor: actor(authorId),
        authorId,
        isDrivenMessage: id ? driven.has(id) : false,
        triggerMessageId: id ? correlations.get(id) : undefined,
        replyToMessageId: replyTo,
        ...(isMessage
          ? {
              text: message?.content ?? "",
              attachments: message?.attachments,
              embedCount: data.embeds?.length,
              componentCount: data.components?.length,
            }
          : {}),
        ...(isDelete ? { deletedText: previous?.content ?? "" } : {}),
        ...(data.emoji
          ? {
              emoji: data.emoji.id
                ? `${data.emoji.name ?? "emoji"}:${data.emoji.id}`
                : data.emoji.name,
            }
          : {}),
      });
      if (isDelete && previous) {
        previous.deleted = true;
      }
    }
  }

  return {
    async connect() {
      params.assertActive();
      params.signal?.throwIfAborted();
      if (!ready) {
        ready = new Promise<void>((resolve, reject) => {
          rejectReady = reject;
          socket = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
          params.signal?.addEventListener("abort", abort, { once: true });
          timeout = setTimeout(() => fail(new Error("Discord recorder READY timed out")), 30_000);
          const send = (payload: unknown) => {
            params.assertActive();
            params.signal?.throwIfAborted();
            if (socket?.readyState !== WebSocket.OPEN) {
              throw new Error("Discord recorder socket is not open");
            }
            socket.send(JSON.stringify(payload));
          };
          const beat = () => {
            try {
              if (awaitingAck) {
                throw new Error("Discord recorder missed heartbeat ACK; evidence is incomplete");
              }
              send({ op: 1, d: sequence });
              awaitingAck = true;
            } catch (error) {
              fail(error);
            }
          };
          socket.on("message", (raw) => {
            if (closed || failure) {
              return;
            }
            try {
              params.assertActive();
              params.signal?.throwIfAborted();
              const packet = dispatchSchema.parse(JSON.parse(rawDataToString(raw)));
              if (typeof packet.s === "number") {
                sequence = packet.s;
              }
              if (packet.op === 10) {
                const hello = z
                  .object({ heartbeat_interval: z.number().positive() })
                  .parse(packet.d);
                clearInterval(heartbeat);
                heartbeat = setInterval(beat, hello.heartbeat_interval);
                // GUILDS, GUILD_MESSAGES, REACTIONS, TYPING, MESSAGE_CONTENT.
                send({
                  op: 2,
                  d: {
                    token: params.token,
                    intents: 1 | 512 | 1024 | 2048 | 32768,
                    properties: {
                      os: process.platform,
                      browser: "openclaw-qa",
                      device: "openclaw-qa",
                    },
                  },
                });
              } else if (packet.op === 11) {
                awaitingAck = false;
              } else if (packet.op === 1) {
                send({ op: 1, d: sequence });
              } else if (packet.op === 7 || packet.op === 9) {
                throw new Error(
                  `Discord recorder requires a new session (op ${packet.op}); evidence is incomplete`,
                );
              } else if (packet.op === 0 && packet.t === "READY") {
                const identity = z
                  .object({ user: z.object({ id: z.string(), bot: z.literal(true) }) })
                  .parse(packet.d);
                if (identity.user.id !== params.driverId) {
                  throw new Error("Discord recorder identity differs from the leased driver bot");
                }
                clearTimeout(timeout);
                resolve();
              } else if (packet.op === 0 && packet.t && recordedKinds[packet.t]) {
                ingest(packet.t, packet.d);
              }
            } catch (error) {
              fail(error);
            }
          });
          socket.on("error", () =>
            fail(new Error("Discord recorder socket error; evidence is incomplete")),
          );
          socket.on("close", (code) => {
            if (!closed) {
              fail(
                new Error(
                  `Discord recorder closed (${code}); check bot intents and access; evidence is incomplete`,
                ),
              );
            }
          });
        });
      }
      await ready;
      params.assertActive();
      params.signal?.throwIfAborted();
      if (failure) {
        throw failure;
      }
    },
    assertHealthy() {
      if (failure) {
        throw failure;
      }
    },
    trackDriverMessage(id: string) {
      driven.add(id);
      params.record({ source: "ownership", actor: "driver", messageId: id, sequence });
      for (const message of messages.values()) {
        if (message.author?.id === params.sutId && message.message_reference?.message_id === id) {
          correlations.set(message.id, id);
        }
      }
    },
    trackThread(id: string) {
      channels.add(id);
    },
    correlateReply(id: string, triggerMessageId: string) {
      correlations.set(id, triggerMessageId);
      params.record({ source: "correlation", messageId: id, triggerMessageId, sequence });
    },
    messages: () => messages.values(),
    close() {
      if (closed) {
        return;
      }
      params.record({
        source: "recorder",
        phase: "closed",
        continuous: !failure,
        failure: failure?.message,
        sequence,
      });
      closed = true;
      rejectReady?.(new Error("Discord recorder closed"));
      stop();
    },
  };
}
