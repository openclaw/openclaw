// Matrix inbound burst debouncing (`messages.inbound.byChannel.matrix` / `debounceMs`).
// Each m.room.message is keyed by room, sender, and thread. Plain text bursts merge into
// one turn. Media and everything else dispatch immediately in per-key order.
import {
  createChannelInboundDebouncer,
  resolveInboundDebounceMs,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
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

function readRelation(event: MatrixRawEvent) {
  return asNullableObjectRecord(event.content["m.relates_to"]);
}

function resolveThreadRootId(event: MatrixRawEvent): string {
  const relation = readRelation(event);
  return relation?.rel_type === "m.thread" ? (readStringValue(relation.event_id) ?? "") : "";
}

/** New, unedited messages only; edits, reactions, and real replies keep their own turn. */
function isPlainNewMessage(event: MatrixRawEvent): boolean {
  if (event.unsigned?.redacted_because || event.unsigned?.["m.relations"]?.["m.replace"]) {
    return false;
  }
  const relation = readRelation(event);
  if (!relation) {
    return true;
  }
  if (relation.rel_type !== undefined && relation.rel_type !== "m.thread") {
    return false;
  }
  // Thread messages carry an m.in_reply_to fallback for older clients; that is not a reply.
  return relation["m.in_reply_to"] === undefined || relation.is_falling_back === true;
}

function readFormattedBody(event: MatrixRawEvent): string | undefined {
  return event.content.format === MATRIX_HTML_FORMAT
    ? readStringValue(event.content.formatted_body)
    : undefined;
}

function readTextBody(event: MatrixRawEvent): string {
  return readStringValue(event.content.body)?.trim() ?? "";
}

function mergeMentions(events: readonly MatrixRawEvent[]): Record<string, unknown> | undefined {
  const userIds = new Set<string>();
  let room = false;
  let present = false;
  for (const event of events) {
    const mentions = asNullableObjectRecord(event.content["m.mentions"]);
    if (!mentions) {
      continue;
    }
    present = true;
    room ||= mentions.room === true;
    for (const userId of Array.isArray(mentions.user_ids) ? mentions.user_ids : []) {
      if (typeof userId === "string") {
        userIds.add(userId);
      }
    }
  }
  if (!present) {
    return undefined;
  }
  return { ...(userIds.size > 0 ? { user_ids: [...userIds] } : {}), ...(room ? { room } : {}) };
}

/** Build the single event dispatched for a text burst; the latest event's id is kept for reply threading. */
function mergeMatrixInboundBurst(events: readonly MatrixRawEvent[]): MatrixRawEvent {
  const base = events.at(-1);
  if (!base) {
    throw new Error("cannot merge an empty Matrix inbound burst");
  }
  const textEvents = events.filter((event) => readTextBody(event));
  const text = textEvents.map(readTextBody).join("\n");
  // Keep each event's HTML in the merged formatted_body: the handler validates native
  // mentions from matrix.to anchors there, and bare m.mentions metadata is not trusted.
  const hasHtml = textEvents.some(readFormattedBody);
  const { format: _format, formatted_body: _formattedBody, ...content } = base.content;
  if (hasHtml) {
    content.format = MATRIX_HTML_FORMAT;
    content.formatted_body = textEvents
      .map((event) => readFormattedBody(event) ?? escapeHtml(readTextBody(event)))
      .join("<br>");
  }
  const mentions = mergeMentions(events);
  if (mentions) {
    content["m.mentions"] = mentions;
  }
  content.body = text;
  return { ...base, content };
}

function buildBatchKey(roomId: string, event: MatrixRawEvent): string | null {
  return event.type === EventType.RoomMessage && event.sender
    ? `${roomId}\u0000${event.sender}\u0000${resolveThreadRootId(event)}`
    : null;
}

export function createMatrixInboundDebouncer(params: {
  cfg: CoreConfig;
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
  const { cfg, handleRoomMessage, inboundDeduper, logVerboseMessage } = params;
  // Live config so debounce changes apply without reconnecting, like other channels.
  const readConfig = createRuntimeConfigReader(cfg);

  const shouldDebounce = ({ event, commandCheckText }: MatrixInboundDebounceEntry): boolean => {
    if (
      event.type !== EventType.RoomMessage ||
      event.sender === params.selfUserId ||
      !isPlainNewMessage(event) ||
      params.isPreStartupEvent(event)
    ) {
      return false;
    }
    if (event.content.msgtype !== "m.text") {
      return false;
    }
    return shouldDebounceTextInbound({ text: commandCheckText, cfg: readConfig() });
  };

  /**
   * Claim every batched event before choosing the merge base, so a redelivered copy or an
   * already-handled event drops out on its own instead of rejecting the whole merged turn.
   */
  const claimBatch = async (roomId: string, events: readonly MatrixRawEvent[]) => {
    const kept: Array<{ event: MatrixRawEvent; claim?: ChannelReplayClaimHandle }> = [];
    const seen = new Set<string>();
    for (const event of events) {
      const eventId = event.event_id?.trim();
      if (!eventId) {
        kept.push({ event });
        continue;
      }
      if (seen.has(eventId)) {
        logVerboseMessage(`matrix: skip repeated debounced event room=${roomId} id=${eventId}`);
        continue;
      }
      seen.add(eventId);
      const claim = await inboundDeduper.claim({ roomId, eventId });
      if (claim.kind === "claimed") {
        kept.push({ event, claim: claim.handle });
      } else if (claim.kind === "invalid") {
        kept.push({ event });
      } else {
        logVerboseMessage(`matrix: skip duplicate debounced event room=${roomId} id=${eventId}`);
      }
    }
    return kept;
  };

  // First sighting per message id, held until that event's batch settles. Without this, the
  // second emit of a pending message joins its own batch, or a bypassed copy dispatches
  // ahead of it. Once settled, the replay guard owns duplicates: a
  // committed event stays suppressed there, and a released one must be processable again.
  const recentSightings = new Map<string, number>();
  const sightingKeyOf = (roomId: string, event: MatrixRawEvent) => {
    const eventId = event.event_id?.trim();
    return event.type === EventType.RoomMessage && eventId ? `${roomId}\u0000${eventId}` : null;
  };
  const settleSightings = (entries: readonly MatrixInboundDebounceEntry[]) => {
    for (const { roomId, event } of entries) {
      const sightingKey = sightingKeyOf(roomId, event);
      if (sightingKey) {
        recentSightings.delete(sightingKey);
      }
    }
  };
  const isRepeatSighting = (roomId: string, event: MatrixRawEvent): boolean => {
    const sightingKey = sightingKeyOf(roomId, event);
    if (!sightingKey) {
      return false;
    }
    const now = Date.now();
    for (const [id, seenAt] of recentSightings) {
      if (now - seenAt < REPEAT_SIGHTING_TTL_MS && recentSightings.size < REPEAT_SIGHTING_MAX) {
        break;
      }
      recentSightings.delete(id);
    }
    if (recentSightings.has(sightingKey)) {
      logVerboseMessage(`matrix: debounce skip repeated emit room=${roomId} id=${event.event_id}`);
      return true;
    }
    recentSightings.set(sightingKey, now);
    return false;
  };

  const { debouncer } = createChannelInboundDebouncer<MatrixInboundDebounceEntry>({
    cfg,
    channel: "matrix",
    resolveDebounceMs: () => resolveInboundDebounceMs({ cfg: readConfig(), channel: "matrix" }),
    buildKey: ({ roomId, event }) => buildBatchKey(roomId, event),
    shouldDebounce,
    onFlush: (entries, createFlush) =>
      createFlush({
        dispatch: async (admission) => {
          try {
            await dispatchBatch(entries, admission);
          } finally {
            settleSightings(entries);
          }
        },
      }),
    onError: params.onError,
  });

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
    let options: MatrixRoomMessageDispatchOptions = { admission };
    if (entries.length > 1) {
      const kept = await claimBatch(
        roomId,
        entries.map((entry) => entry.event),
      );
      const base = kept.at(-1);
      if (!base) {
        return;
      }
      event =
        kept.length > 1 ? mergeMatrixInboundBurst(kept.map((entry) => entry.event)) : base.event;
      options = {
        admission,
        replayClaim: base.claim,
        absorbedReplayClaims: kept
          .filter((entry) => entry !== base)
          .flatMap((entry) => (entry.claim ? [entry.claim] : [])),
      };
      logVerboseMessage(
        `matrix: debounce merged ${kept.length} events room=${roomId} into id=${event.event_id ?? "unknown"}`,
      );
    }
    let started = false;
    await params.runDetachedTask(
      `debounced room message handler room=${roomId} id=${event.event_id ?? "unknown"}`,
      async () => {
        started = true;
        await handleRoomMessage(roomId, event, options);
      },
    );
    if (!started) {
      // The monitor stopped before this batch's timer fired; leave the events replayable.
      options.replayClaim?.release();
      for (const claim of options.absorbedReplayClaims ?? []) {
        claim.release();
      }
      logVerboseMessage(`matrix: dropped debounced batch after monitor stop room=${roomId}`);
    }
  }

  /** Normalize like the handler does, so "@Bot: /stop" bypasses batching too. */
  const resolveCommandCheckText = async (roomId: string, event: MatrixRawEvent) => {
    if (event.type !== EventType.RoomMessage || event.content.msgtype !== "m.text") {
      return undefined;
    }
    const inputs = await params.resolveCommandPrefixInputs(roomId, event);
    return stripMatrixMentionPrefix({
      text: readTextBody(event),
      userId: params.selfUserId,
      displayName: inputs.displayName,
      mentionRegexes: inputs.mentionRegexes,
    });
  };

  // Prefix resolution is async; chain it per key so a burst still reaches the debouncer in
  // arrival order. Each link ends once its item is registered, not when its turn finishes.
  const ingressChains = new Map<string, Promise<void>>();

  return async (roomId: string, event: MatrixRawEvent) => {
    if (isRepeatSighting(roomId, event)) {
      return;
    }
    const key = buildBatchKey(roomId, event);
    if (!key) {
      await debouncer.enqueue({ roomId, event });
      return;
    }
    let enqueued: Promise<void> = Promise.resolve();
    const registered = (ingressChains.get(key) ?? Promise.resolve()).then(async () => {
      // A failed lookup leaves no command text, which dispatches the event on its own.
      const commandCheckText = await resolveCommandCheckText(roomId, event).catch(() => "");
      enqueued = debouncer.enqueue({ roomId, event, commandCheckText });
    });
    const settled = registered.catch(() => undefined);
    ingressChains.set(key, settled);
    void settled.then(() => {
      if (ingressChains.get(key) === settled) {
        ingressChains.delete(key);
      }
    });
    await registered;
    await enqueued;
  };
}
