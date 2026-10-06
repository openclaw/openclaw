// Matrix inbound burst debouncing (`messages.inbound.byChannel.matrix` / `debounceMs`).
// Each m.room.message is keyed by room, sender, and thread. Plain text bursts merge into
// one turn. Media and everything else dispatch immediately in per-key order.
import {
  createChannelInboundDebouncer,
  resolveInboundDebounceMs,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { asNullableObjectRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CoreConfig } from "../../types.js";
import type { MatrixRoomMessageDispatchOptions, MatrixRoomMessageHandler } from "./handler.js";
import type { MatrixInboundEventDeduper } from "./inbound-dedupe.js";
import { stripMatrixMentionPrefix } from "./mentions.js";
import { EventType, type MatrixRawEvent } from "./types.js";

type MatrixInboundDebounceEntry = {
  roomId: string;
  event: MatrixRawEvent;
  /** Text after the handler's mention-prefix normalization; decides command bypass. */
  commandCheckText?: string;
};

/** Inputs the handler's mention-prefix normalizer uses for this event. */
export type MatrixCommandPrefixInputs = { displayName?: string; mentionRegexes: RegExp[] };

const MATRIX_HTML_FORMAT = "org.matrix.custom.html";

// E2EE delivers each decrypted message twice (room.decrypted_event and room.message) within
// milliseconds. Repeats are dropped before batching while the first copy is still pending;
// the TTL only bounds entries whose batch never settles.
const REPEAT_SIGHTING_TTL_MS = 60_000;
const REPEAT_SIGHTING_MAX = 1024;

const readTextBody = (event: MatrixRawEvent) => readStringValue(event.content.body)?.trim() ?? "";

const readFormattedBody = (event: MatrixRawEvent) =>
  event.content.format === MATRIX_HTML_FORMAT
    ? readStringValue(event.content.formatted_body)
    : undefined;

/** New, unedited messages only; edits, reactions, and real replies keep their own turn. */
function isPlainNewMessage(event: MatrixRawEvent): boolean {
  if (event.unsigned?.redacted_because || event.unsigned?.["m.relations"]?.["m.replace"]) {
    return false;
  }
  const relation = asNullableObjectRecord(event.content["m.relates_to"]);
  if (!relation) {
    return true;
  }
  if (relation.rel_type !== undefined && relation.rel_type !== "m.thread") {
    return false;
  }
  // Thread messages carry an m.in_reply_to fallback for older clients; that is not a reply.
  return relation["m.in_reply_to"] === undefined || relation.is_falling_back === true;
}

function buildBatchKey(roomId: string, event: MatrixRawEvent): string | null {
  if (event.type !== EventType.RoomMessage || !event.sender) {
    return null;
  }
  const relation = asNullableObjectRecord(event.content["m.relates_to"]);
  const threadRootId =
    relation?.rel_type === "m.thread" ? (readStringValue(relation.event_id) ?? "") : "";
  return `${roomId}\u0000${event.sender}\u0000${threadRootId}`;
}

/** Build the single event dispatched for a text burst; the latest event's id is kept for reply threading. */
function mergeMatrixInboundBurst(events: readonly MatrixRawEvent[], base: MatrixRawEvent) {
  const textEvents = events.filter(readTextBody);
  const { format: _format, formatted_body: _formattedBody, ...content } = base.content;
  content.body = textEvents.map(readTextBody).join("\n");
  // Keep each event's HTML in the merged formatted_body: the handler validates native
  // mentions from matrix.to anchors there, and bare m.mentions metadata is not trusted.
  if (textEvents.some(readFormattedBody)) {
    content.format = MATRIX_HTML_FORMAT;
    content.formatted_body = textEvents
      .map((event) => readFormattedBody(event) ?? escapeHtml(readTextBody(event)))
      .join("<br>");
  }
  const mentions = events.flatMap((event) => {
    const record = asNullableObjectRecord(event.content["m.mentions"]);
    return record ? [record] : [];
  });
  if (mentions.length > 0) {
    const userIds = new Set(
      mentions
        .flatMap((m) => (Array.isArray(m.user_ids) ? m.user_ids : []))
        .filter((id): id is string => typeof id === "string"),
    );
    content["m.mentions"] = {
      ...(userIds.size > 0 ? { user_ids: [...userIds] } : {}),
      ...(mentions.some((m) => m.room === true) ? { room: true } : {}),
    };
  }
  return { ...base, content };
}

/** Settle a merged burst as one replay unit; the merge base's claim comes first. */
function joinMatrixInboundReplayClaims(
  claims: readonly ChannelReplayClaimHandle[],
): ChannelReplayClaimHandle | undefined {
  const [primary, ...absorbed] = claims;
  if (!primary || absorbed.length === 0) {
    return primary;
  }
  return {
    keys: [...primary.keys, ...absorbed.flatMap((claim) => claim.keys)],
    commit: async (options) =>
      (await Promise.all(claims.map((claim) => claim.commit(options))))[0] ?? false,
    release: (options) => {
      for (const claim of claims) {
        claim.release(options);
      }
    },
  };
}

export function createMatrixInboundDebouncer(params: {
  /** Live runtime config; read at use time so debounce changes apply without reconnecting. */
  readConfig: () => CoreConfig;
  selfUserId: string;
  handleRoomMessage: MatrixRoomMessageHandler;
  inboundDeduper: Pick<MatrixInboundEventDeduper, "claim">;
  runDetachedTask: (label: string, task: () => Promise<void>) => Promise<void>;
  logVerboseMessage: (message: string) => void;
  /** Startup eligibility owner; cold-start history must never merge into a fresh turn. */
  isPreStartupEvent: (event: MatrixRawEvent) => boolean;
  /** Display name and mention patterns the handler strips before command detection. */
  resolveCommandPrefixInputs: (
    roomId: string,
    event: MatrixRawEvent,
  ) => Promise<MatrixCommandPrefixInputs>;
  onError: (err: unknown) => void;
}) {
  const { readConfig, selfUserId, logVerboseMessage } = params;
  const isTextMessage = (event: MatrixRawEvent) =>
    event.type === EventType.RoomMessage && event.content.msgtype === "m.text";

  // First sighting per message id, held until that event's batch settles. Without this, the
  // second emit of a pending message joins its own batch, or a bypassed copy dispatches
  // ahead of it. Once settled, the replay guard owns duplicates: a
  // committed event stays suppressed there, and a released one must be processable again.
  const sightings = new Map<string, number>();
  const sightingKeyOf = (roomId: string, event: MatrixRawEvent) =>
    `${roomId}\u0000${event.event_id?.trim() ?? ""}`;
  const isRepeatSighting = (roomId: string, event: MatrixRawEvent): boolean => {
    if (event.type !== EventType.RoomMessage || !event.event_id?.trim()) {
      return false;
    }
    const key = sightingKeyOf(roomId, event);
    const now = Date.now();
    for (const [id, seenAt] of sightings) {
      if (now - seenAt < REPEAT_SIGHTING_TTL_MS && sightings.size < REPEAT_SIGHTING_MAX) {
        break;
      }
      sightings.delete(id);
    }
    if (sightings.has(key)) {
      logVerboseMessage(`matrix: debounce skip repeated emit room=${roomId} id=${event.event_id}`);
      return true;
    }
    sightings.set(key, now);
    return false;
  };

  async function dispatchBatch(
    entries: readonly MatrixInboundDebounceEntry[],
    admission: MatrixRoomMessageDispatchOptions["admission"],
  ) {
    const last = entries.at(-1);
    if (!last) {
      return;
    }
    const { roomId } = last;
    let event = last.event;
    const options: MatrixRoomMessageDispatchOptions = { admission };
    if (entries.length > 1) {
      // Claim every event before choosing the merge base, so an already-handled event drops
      // out on its own instead of rejecting the whole merged turn.
      const kept: Array<{ event: MatrixRawEvent; claim?: ChannelReplayClaimHandle }> = [];
      for (const entry of entries) {
        const eventId = entry.event.event_id?.trim();
        const claim = eventId ? await params.inboundDeduper.claim({ roomId, eventId }) : undefined;
        if (claim?.kind === "claimed") {
          kept.push({ event: entry.event, claim: claim.handle });
        } else if (!claim || claim.kind === "invalid") {
          kept.push({ event: entry.event });
        } else {
          logVerboseMessage(`matrix: skip duplicate debounced event room=${roomId} id=${eventId}`);
        }
      }
      const base = kept.at(-1);
      if (!base) {
        return;
      }
      const events = kept.map((k) => k.event);
      event = kept.length > 1 ? mergeMatrixInboundBurst(events, base.event) : base.event;
      options.replayClaim = joinMatrixInboundReplayClaims(
        [base, ...kept.slice(0, -1)].flatMap((k) => (k.claim ? [k.claim] : [])),
      );
      logVerboseMessage(
        `matrix: debounce merged ${kept.length} events room=${roomId} into id=${event.event_id ?? "unknown"}`,
      );
    }
    let started = false;
    await params.runDetachedTask(
      `debounced room message handler room=${roomId} id=${event.event_id ?? "unknown"}`,
      async () => {
        started = true;
        await params.handleRoomMessage(roomId, event, options);
      },
    );
    if (!started) {
      // The monitor stopped before this batch's timer fired; leave the events replayable.
      options.replayClaim?.release();
      logVerboseMessage(`matrix: dropped debounced batch after monitor stop room=${roomId}`);
    }
  }

  const { debouncer } = createChannelInboundDebouncer<MatrixInboundDebounceEntry>({
    cfg: readConfig(),
    channel: "matrix",
    resolveDebounceMs: () => resolveInboundDebounceMs({ cfg: readConfig(), channel: "matrix" }),
    buildKey: ({ roomId, event }) => buildBatchKey(roomId, event),
    shouldDebounce: ({ event, commandCheckText }) =>
      isTextMessage(event) &&
      event.sender !== selfUserId &&
      isPlainNewMessage(event) &&
      !params.isPreStartupEvent(event) &&
      shouldDebounceTextInbound({ text: commandCheckText, cfg: readConfig() }),
    onFlush: (entries, createFlush) =>
      createFlush({
        dispatch: async (admission) => {
          try {
            await dispatchBatch(entries, admission);
          } finally {
            for (const { roomId, event } of entries) {
              sightings.delete(sightingKeyOf(roomId, event));
            }
          }
        },
      }),
    onError: params.onError,
  });

  /** Normalize like the handler does, so "@Bot: /stop" bypasses batching too. */
  const resolveCommandCheckText = async (roomId: string, event: MatrixRawEvent) => {
    if (!isTextMessage(event)) {
      return undefined;
    }
    const inputs = await params.resolveCommandPrefixInputs(roomId, event);
    return stripMatrixMentionPrefix({ text: readTextBody(event), userId: selfUserId, ...inputs });
  };

  // Prefix resolution is async; queue it per key so a burst still reaches the debouncer in
  // arrival order. Each task ends once its item is registered, not when its turn finishes.
  const ingressQueue = new KeyedAsyncQueue();

  return async (roomId: string, event: MatrixRawEvent) => {
    if (isRepeatSighting(roomId, event)) {
      return;
    }
    const key = buildBatchKey(roomId, event);
    if (!key) {
      await debouncer.enqueue({ roomId, event });
      return;
    }
    const { enqueued } = await ingressQueue.enqueue(key, async () => {
      // A failed lookup leaves no command text, which dispatches the event on its own.
      const commandCheckText = await resolveCommandCheckText(roomId, event).catch(() => "");
      return { enqueued: debouncer.enqueue({ roomId, event, commandCheckText }) };
    });
    await enqueued;
  };
}
