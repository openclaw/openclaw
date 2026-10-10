// Optional pre-turn hold for captionless Matrix attachments. Clients without
// caption support send an attachment and the text typed with it as two events;
// holding the attachment briefly lets that text join it as one captioned turn.
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixMessageAttachment } from "../media-text.js";
import { resolveMatrixThreadRootId } from "../relations.js";
import { RelationType } from "../send/types.js";
import { resolveMatrixInboundMediaContent } from "./handler-helpers.js";
import { stripMatrixMentionPrefix } from "./mentions.js";
import { EventType, type MatrixRawEvent, type RoomMessageEventContent } from "./types.js";

export type MatrixRoomMessageDispatchOptions = {
  /** Events folded into this one; their replay claims settle with the dispatched event. */
  absorbedEventIds?: readonly string[];
};

type MatrixRoomMessageDispatch = (
  roomId: string,
  event: MatrixRawEvent,
  options?: MatrixRoomMessageDispatchOptions,
) => Promise<void>;

type HoldDecision = { event: MatrixRawEvent; options?: MatrixRoomMessageDispatchOptions } | null;

type HoldEntry = {
  roomId: string;
  event: MatrixRawEvent;
  key: string;
  kind: "media" | "text" | "other";
  resolve: (decision: HoldDecision) => void;
  decision: Promise<HoldDecision>;
};

function isHoldableMedia(content: RoomMessageEventContent): boolean {
  const msgtype = typeof content.msgtype === "string" ? content.msgtype : undefined;
  if (
    msgtype !== "m.image" &&
    msgtype !== "m.file" &&
    msgtype !== "m.video" &&
    msgtype !== "m.audio"
  ) {
    return false;
  }
  // Voice notes are complete messages on their own.
  if (content["org.matrix.msc3245.voice"] !== undefined) {
    return false;
  }
  if (!resolveMatrixInboundMediaContent(content).url) {
    return false;
  }
  const attachment = resolveMatrixMessageAttachment({
    body: typeof content.body === "string" ? content.body : undefined,
    filename: typeof content.filename === "string" ? content.filename : undefined,
    msgtype,
  });
  return attachment !== undefined && !attachment.caption;
}

/** Fold a text event into a captionless attachment as an MSC2530 caption. */
export function mergeMatrixMediaCaption(
  media: MatrixRawEvent,
  text: MatrixRawEvent,
): MatrixRawEvent {
  const mediaContent = media.content as RoomMessageEventContent;
  const textContent = text.content as RoomMessageEventContent;
  const {
    format: _format,
    formatted_body: _formattedBody,
    "m.relates_to": _relatesTo,
    "m.mentions": _mentions,
    ...attachment
  } = mediaContent;
  const filename =
    normalizeOptionalString(mediaContent.filename) ?? normalizeOptionalString(mediaContent.body);
  // The text event owns identity, timing, relations and mentions so replies,
  // threading and mention gating follow the message the user actually typed.
  return {
    ...text,
    content: {
      ...attachment,
      ...(filename ? { filename } : {}),
      body: textContent.body,
      ...(textContent.format !== undefined
        ? { format: textContent.format, formatted_body: textContent.formatted_body }
        : {}),
      ...(textContent["m.relates_to"] !== undefined
        ? { "m.relates_to": textContent["m.relates_to"] }
        : {}),
      ...(textContent["m.mentions"] !== undefined
        ? { "m.mentions": textContent["m.mentions"] }
        : {}),
    },
  };
}

/**
 * Wrap the room message handler so a captionless attachment waits up to `holdMs` for
 * the sender's next text in the same room and thread. Any other message in that
 * conversation, a second attachment, a control command or the deadline dispatches the
 * held attachment alone, exactly as without the hold.
 */
export function createMatrixMediaHold(params: {
  holdMs: number;
  selfUserId: string;
  dispatch: MatrixRoomMessageDispatch;
  isControlCommand: (text: string) => boolean;
  logVerboseMessage: (message: string) => void;
}) {
  const { holdMs } = params;
  const heldByKey = new Map<string, Set<HoldEntry>>();

  const classify = (roomId: string, event: MatrixRawEvent): HoldEntry | undefined => {
    if (event.type !== EventType.RoomMessage || !event.sender) {
      return undefined;
    }
    if (event.sender === params.selfUserId || event.unsigned?.redacted_because) {
      return undefined;
    }
    const content = event.content as RoomMessageEventContent;
    if (content["m.relates_to"]?.rel_type === RelationType.Replace) {
      return undefined;
    }
    const threadRootId = resolveMatrixThreadRootId(content) ?? "";
    const body = typeof content.body === "string" ? content.body.trim() : "";
    const kind = isHoldableMedia(content)
      ? "media"
      : content.msgtype === "m.text" &&
          body &&
          !params.isControlCommand(body) &&
          !params.isControlCommand(
            stripMatrixMentionPrefix({ text: body, userId: params.selfUserId }),
          )
        ? "text"
        : "other";
    let resolve!: (decision: HoldDecision) => void;
    const decision = new Promise<HoldDecision>((done) => {
      resolve = done;
    });
    return {
      roomId,
      event,
      key: `${roomId}\0${threadRootId}`,
      kind,
      resolve,
      decision,
    };
  };

  const release = (entry: HoldEntry) => {
    const held = heldByKey.get(entry.key);
    held?.delete(entry);
    if (held?.size === 0) {
      heldByKey.delete(entry.key);
    }
  };

  const debouncer = createInboundDebouncer<HoldEntry>({
    debounceMs: holdMs,
    // The window is measured from the attachment; a joining text never extends it.
    maxWaitMs: holdMs,
    buildKey: (entry) => entry.key,
    // Only the held attachment's own sender can complete it; anything else in the
    // conversation dispatches it first so delivery order is preserved.
    canAppend: (entry, pending) =>
      entry.kind === "text" &&
      pending.length === 1 &&
      pending[0]?.kind === "media" &&
      pending[0].event.sender === entry.event.sender,
    resolveDebounceMs: (entry, pending) => (entry.kind === "media" || pending ? holdMs : 0),
    onFlush: (entries, createFlush) =>
      createFlush({
        // The handler runs in the held event's own monitor task; the keyed lane only
        // decides grouping and order, so it is released immediately.
        dispatch: async () => {
          for (const entry of entries) {
            release(entry);
          }
          const [first, second] = entries;
          if (!first) {
            return;
          }
          if (second) {
            params.logVerboseMessage(
              `matrix: media hold joined room=${first.roomId} media=${first.event.event_id} text=${second.event.event_id}`,
            );
            first.resolve({
              event: mergeMatrixMediaCaption(first.event, second.event),
              options: { absorbedEventIds: [first.event.event_id] },
            });
            second.resolve(null);
            return;
          }
          first.resolve({ event: first.event });
        },
      }),
  });

  const onRoomMessage = async (roomId: string, event: MatrixRawEvent): Promise<void> => {
    const entry = classify(roomId, event);
    if (!entry) {
      await params.dispatch(roomId, event);
      return;
    }
    const joinsHeldMedia = entry.kind === "text" && debouncer.shouldBuffer(entry);
    if (entry.kind === "media") {
      const held = heldByKey.get(entry.key) ?? new Set<HoldEntry>();
      held.add(entry);
      heldByKey.set(entry.key, held);
    }
    const queued = debouncer.enqueue(entry);
    if (joinsHeldMedia) {
      // The text completes the pair; there is nothing left to wait for.
      void debouncer.flushKey(entry.key);
    }
    await queued;
    const decision = await entry.decision;
    if (decision) {
      await params.dispatch(roomId, decision.event, decision.options);
    }
  };

  /** Dispatch every held attachment now, for example before the monitor stops. */
  const flushHeld = async (): Promise<void> => {
    await Promise.all([...heldByKey.keys()].map((key) => debouncer.flushKey(key)));
  };

  return { onRoomMessage, flushHeld };
}
