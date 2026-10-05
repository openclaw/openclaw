// Matrix inbound burst debouncing (`messages.inbound.byChannel.matrix` / `debounceMs`).
// Each m.room.message is keyed by room, sender, and thread. Plain text bursts merge into
// one turn. One caption-less image/file/video waits for the sender's trailing text and
// uses it as the caption, because Element Web sends an attachment and the composer text
// as separate events. Everything else dispatches immediately in per-key order.
import {
  createChannelInboundDebouncer,
  resolveInboundDebounceMs,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { asNullableObjectRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixMessageAttachment } from "../media-text.js";
import type { MatrixRoomMessageDispatchOptions, MatrixRoomMessageHandler } from "./handler.js";
import type { MatrixInboundEventDeduper } from "./inbound-dedupe.js";
import { stripMatrixMentionPrefix } from "./mentions.js";
import { EventType, type MatrixRawEvent } from "./types.js";

type MatrixInboundDebounceEntry = { roomId: string; event: MatrixRawEvent };

// Audio and stickers stay immediate: voice notes are complete messages on their own.
const CAPTION_WAITING_MSGTYPES = new Set(["m.image", "m.file", "m.video"]);

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

function hasMediaSource(event: MatrixRawEvent): boolean {
  const file = asNullableObjectRecord(event.content.file);
  return Boolean(readStringValue(event.content.url) ?? readStringValue(file?.url));
}

function isCaptionlessMedia(event: MatrixRawEvent): boolean {
  const msgtype = readStringValue(event.content.msgtype);
  if (!msgtype || !CAPTION_WAITING_MSGTYPES.has(msgtype) || !hasMediaSource(event)) {
    return false;
  }
  const attachment = resolveMatrixMessageAttachment({
    body: readStringValue(event.content.body),
    filename: readStringValue(event.content.filename),
    msgtype,
  });
  return attachment !== undefined && attachment.caption === undefined;
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

/**
 * Build the single event dispatched for a burst. Text bursts keep the latest event's
 * id for reply threading; a media burst keeps the media event and carries the joined
 * text as an MSC2530 caption (`body` = caption, `filename` = original name).
 */
function mergeMatrixInboundBurst(events: readonly MatrixRawEvent[]): MatrixRawEvent {
  const media = events.find(isCaptionlessMedia);
  const base = media ?? events.at(-1);
  if (!base) {
    throw new Error("cannot merge an empty Matrix inbound burst");
  }
  const text = events
    .filter((event) => event !== media)
    .map(readTextBody)
    .filter(Boolean)
    .join("\n");
  // Joined plain text replaces each event's own HTML, so drop the base event's HTML.
  const { format: _format, formatted_body: _formattedBody, ...content } = base.content;
  const mentions = mergeMentions(events);
  if (mentions) {
    content["m.mentions"] = mentions;
  }
  if (media) {
    const filename =
      readStringValue(media.content.filename)?.trim() || readTextBody(media) || "attachment";
    content.filename = filename;
    content.body = text || filename;
  } else {
    content.body = text;
  }
  return { ...base, content };
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
  onError: (err: unknown) => void;
}) {
  const { cfg, handleRoomMessage, inboundDeduper, logVerboseMessage } = params;
  // Live config so debounce changes apply without reconnecting, like other channels.
  const readConfig = createRuntimeConfigReader(cfg);

  const shouldDebounce = ({ event }: MatrixInboundDebounceEntry): boolean => {
    if (
      event.type !== EventType.RoomMessage ||
      event.sender === params.selfUserId ||
      !isPlainNewMessage(event) ||
      params.isPreStartupEvent(event)
    ) {
      return false;
    }
    if (isCaptionlessMedia(event)) {
      return true;
    }
    if (event.content.msgtype !== "m.text") {
      return false;
    }
    return shouldDebounceTextInbound({
      text: stripMatrixMentionPrefix({ text: readTextBody(event), userId: params.selfUserId }),
      cfg: readConfig(),
    });
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

  const { debouncer } = createChannelInboundDebouncer<MatrixInboundDebounceEntry>({
    cfg,
    channel: "matrix",
    resolveDebounceMs: () => resolveInboundDebounceMs({ cfg: readConfig(), channel: "matrix" }),
    buildKey: ({ roomId, event }) =>
      event.type === EventType.RoomMessage && event.sender
        ? `${roomId}\u0000${event.sender}\u0000${resolveThreadRootId(event)}`
        : null,
    shouldDebounce,
    // One attachment per turn: a second caption-less upload starts its own batch.
    canAppend: (item, pending) =>
      !isCaptionlessMedia(item.event) || !pending.some((entry) => isCaptionlessMedia(entry.event)),
    onFlush: (entries, createFlush) =>
      createFlush({
        dispatch: async (admission) => {
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
            const base = kept.find((entry) => isCaptionlessMedia(entry.event)) ?? kept.at(-1);
            if (!base) {
              return;
            }
            event =
              kept.length > 1
                ? mergeMatrixInboundBurst(kept.map((entry) => entry.event))
                : base.event;
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
        },
      }),
    onError: params.onError,
  });

  return async (roomId: string, event: MatrixRawEvent) => {
    await debouncer.enqueue({ roomId, event });
  };
}
