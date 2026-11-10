// Optional hold for captionless Matrix attachments. Clients without caption
// support send an attachment and the text typed with it as two events; holding
// the attachment briefly lets that text join it as one captioned turn.
//
// The hold sits between durable ingress and the room message handler. A held
// attachment keeps its own ingress claim: its delivery returns deferred so the
// room lane stays free for the text, and the merged turn adopts, defers or
// abandons both claims together. Nothing is re-claimed and nothing is replayed.
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type {
  ChannelIngressMonitorDeliveryResult,
  ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig, MatrixConfig } from "../../types.js";
import { resolveMatrixMessageAttachment } from "../media-text.js";
import { isPollEventType } from "../poll-types.js";
import { extractMatrixReactionAnnotation } from "../reaction-common.js";
import { resolveMatrixThreadRootId } from "../relations.js";
import { getMatrixEventProjection } from "../sdk/event-helpers.js";
import { RelationType } from "../send/types.js";
import type { createDirectRoomTracker } from "./direct.js";
import {
  hasBundledMatrixReplacementRelation,
  resolveMatrixInboundMediaContent,
  resolveMatrixMentionPrecheckText,
} from "./handler-helpers.js";
import { resolveMatrixCommandCheckText } from "./mentions.js";
import { resolveMatrixInboundRouteAsync } from "./route.js";
import { resolveMatrixThreadRouting } from "./threads.js";
import { EventType, type MatrixRawEvent, type RoomMessageEventContent } from "./types.js";
import { isMatrixVerificationRoomMessage } from "./verification-utils.js";

export type MatrixRoomMessageDispatch = (
  roomId: string,
  event: MatrixRawEvent,
  lifecycle: ChannelIngressMonitorLifecycle,
) => Promise<ChannelIngressMonitorDeliveryResult | void>;

type HoldKind = "media" | "text" | "other" | "reaction";

type HoldEntry = {
  roomId: string;
  event: MatrixRawEvent;
  lifecycle: ChannelIngressMonitorLifecycle;
  key: string;
  kind: HoldKind;
  /** Hold window to use instead of the one derived from the attachment's age. */
  windowMs?: number;
  heartbeat?: ReturnType<typeof setInterval>;
  onAbort?: () => void;
};

function asRoomMessageContent(event: MatrixRawEvent): RoomMessageEventContent {
  // SAFETY: Matrix raw event content is an open record; the reads below check each field's type.
  return event.content as RoomMessageEventContent;
}

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
  const body = typeof content.body === "string" ? content.body : undefined;
  const filename = typeof content.filename === "string" ? content.filename : undefined;
  const attachment = resolveMatrixMessageAttachment({ body, filename, msgtype });
  if (attachment === undefined) {
    return false;
  }
  if (!attachment.caption) {
    return true;
  }
  // Clients that predate MSC2530 send no `filename` and put the file name in
  // `body`; "vacation photo.jpg" is a name there, not a caption.
  return filename === undefined && body !== undefined && isLegacyMediaFilenameBody(body);
}

function isLegacyMediaFilenameBody(body: string): boolean {
  const trimmed = body.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 255 &&
    !/[\r\n]/.test(trimmed) &&
    !/[.!?]\s/.test(trimmed) &&
    /\.[A-Za-z0-9]{1,8}$/.test(trimmed)
  );
}

/** Fold a text event into a captionless attachment as an MSC2530 caption. */
export function mergeMatrixMediaCaption(
  media: MatrixRawEvent,
  text: MatrixRawEvent,
): MatrixRawEvent {
  const mediaContent = asRoomMessageContent(media);
  const textContent = asRoomMessageContent(text);
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
 * The handler's own control-command decision (route, mention patterns, display
 * name) for a text that would otherwise join a held attachment.
 */
export function createMatrixHoldControlCommandCheck(params: {
  core: Pick<PluginRuntime, "channel" | "config">;
  accountId: string;
  accountConfig: MatrixConfig;
  dmSessionScope?: "per-user" | "per-room";
  threadReplies: "off" | "inbound" | "always";
  dmThreadReplies?: "off" | "inbound" | "always";
  selfUserId: string;
  directTracker: Pick<ReturnType<typeof createDirectRoomTracker>, "isDirectMessage">;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
}) {
  return async (roomId: string, event: MatrixRawEvent): Promise<boolean> => {
    // The same live snapshot normal ingress reads, so a hot-reloaded mention
    // pattern is recognised here before it would be by the handler.
    // SAFETY: the runtime's current config is the OpenClaw config this plugin reads as CoreConfig.
    const cfg = params.core.config.current() as CoreConfig;
    const content = asRoomMessageContent(event);
    const senderId = event.sender ?? "";
    const isDirectMessage = await params.directTracker.isDirectMessage({
      roomId,
      senderId,
      selfUserId: params.selfUserId,
    });
    // The same effective thread normal ingress routes by, so a thread bound to
    // another agent only applies when thread replies are on.
    const { threadId } = resolveMatrixThreadRouting({
      isDirectMessage,
      threadReplies: params.threadReplies,
      dmThreadReplies: params.dmThreadReplies,
      messageId: event.event_id,
      threadRootId: resolveMatrixThreadRootId(content),
    });
    const { route } = await resolveMatrixInboundRouteAsync({
      cfg,
      accountId: params.accountId,
      roomId,
      senderId,
      isDirectMessage,
      dmSessionScope: params.dmSessionScope,
      threadId,
      resolveAgentRoute: params.core.channel.routing.resolveAgentRoute,
    });
    const selfDisplayName = content.formatted_body
      ? await params.getMemberDisplayName(roomId, params.selfUserId).catch(() => undefined)
      : undefined;
    const { commandCheckText } = resolveMatrixCommandCheckText({
      core: params.core,
      cfg,
      agentId: route.agentId,
      roomId,
      mentionPatterns: params.accountConfig.mentionPatterns,
      selfUserId: params.selfUserId,
      selfDisplayName,
      text: resolveMatrixMentionPrecheckText({ eventType: event.type, content }),
    });
    // The canonical predicate: configured commands plus bare abort triggers ("stop").
    return params.core.channel.commands.isControlCommandMessage(commandCheckText, cfg);
  };
}

function isQueuedMatrixEvent(value: unknown): value is { event: MatrixRawEvent } {
  if (!value || typeof value !== "object" || !("event" in value)) {
    return false;
  }
  const event = value.event;
  return (
    event !== null &&
    typeof event === "object" &&
    "event_id" in event &&
    typeof event.event_id === "string" &&
    "content" in event &&
    event.content !== null &&
    typeof event.content === "object"
  );
}

/** The event a reaction annotates, read the way the reaction handler reads it. */
export function resolveReactionTargetId(event: MatrixRawEvent): string | undefined {
  return extractMatrixReactionAnnotation(event.content)?.eventId;
}

function isWithinHoldWindow(media: MatrixRawEvent, text: MatrixRawEvent, holdMs: number) {
  const delta = text.origin_server_ts - media.origin_server_ts;
  return Number.isFinite(delta) && delta >= 0 && delta <= holdMs;
}

/**
 * Events the handler turns into messages or acts on. Anything else (and the
 * bot's own events, redactions and edits, which the handler ignores, including
 * an original the server already bundles a replacement for) bypasses the hold
 * so it can never release an attachment early or be folded into one.
 */
/** Events the handler never turns into work: the bot's own, redacted, edited, verification. */
function isIgnoredByHandler(event: MatrixRawEvent, selfUserId: string): boolean {
  if (
    !event.sender ||
    event.sender === selfUserId ||
    event.unsigned?.redacted_because ||
    hasBundledMatrixReplacementRelation(event)
  ) {
    return true;
  }
  if (event.type !== EventType.RoomMessage) {
    return false;
  }
  const content = asRoomMessageContent(event);
  return (
    content["m.relates_to"]?.rel_type === RelationType.Replace ||
    isMatrixVerificationRoomMessage({ msgtype: content.msgtype, body: content.body })
  );
}

function classifyHoldKind(event: MatrixRawEvent, selfUserId: string): HoldKind | undefined {
  if (isIgnoredByHandler(event, selfUserId)) {
    return undefined;
  }
  if (isPollEventType(event.type) || event.type === EventType.Location) {
    return "other";
  }
  if (event.type === EventType.Reaction) {
    return "reaction";
  }
  if (event.type !== EventType.RoomMessage) {
    return undefined;
  }
  const content = asRoomMessageContent(event);
  if (isHoldableMedia(content)) {
    return "media";
  }
  const body = typeof content.body === "string" ? content.body.trim() : "";
  return content.msgtype === "m.text" && body ? "text" : "other";
}

/** Decrypts events from local SDK state, the way ingress hydrates each delivery. */
export type MatrixHoldEventHydrator = (
  roomId: string,
  events: MatrixRawEvent[],
) => Promise<Array<MatrixRawEvent | undefined>>;

/** One event of a sync batch whose admission has not finished yet. */
export type MatrixHoldSyncBatchEvent = { roomId: string; event: MatrixRawEvent };

function isCompanionText(roomId: string, queued: MatrixRawEvent, key: string): boolean {
  const content = asRoomMessageContent(queued);
  const body = typeof content.body === "string" ? content.body.trim() : "";
  const queuedKey = `${roomId}\0${resolveMatrixThreadRootId(content) ?? ""}`;
  return content.msgtype === "m.text" && body.length > 0 && queuedKey === key;
}

/**
 * Whether a text from the attachment's sender, sent within the hold window and
 * in the same room and thread, is already durable behind it in the lane, or is
 * in the sync batch still being admitted after it.
 *
 * Queued ciphertext is decrypted through the same SDK path ingress uses before
 * it is judged. A row that cannot be decrypted yet still counts when its
 * envelope (sender, time, thread relation) fits: the attachment then waits one
 * hold window, and the text is checked again by the normal join rules when the
 * lane delivers it decrypted, so a wrong guess only costs that bounded wait.
 */
async function hasQueuedCompanionText(params: {
  roomId: string;
  media: MatrixRawEvent;
  key: string;
  lifecycle: ChannelIngressMonitorLifecycle;
  holdMs: number;
  selfUserId: string;
  batchEvents: MatrixRawEvent[];
  hydrateEvents?: MatrixHoldEventHydrator;
}): Promise<boolean> {
  const { roomId, media, key, holdMs, selfUserId } = params;
  const rows = await params.lifecycle.readLaneBacklog?.().catch(() => []);
  const queuedEvents = [
    ...(rows ?? []).flatMap((row) => (isQueuedMatrixEvent(row.payload) ? [row.payload.event] : [])),
    ...params.batchEvents,
  ].filter(
    (queued) =>
      queued.event_id !== media.event_id &&
      queued.sender === media.sender &&
      !isIgnoredByHandler(queued, selfUserId) &&
      isWithinHoldWindow(media, queued, holdMs),
  );
  if (
    queuedEvents.some(
      (queued) => queued.type === EventType.RoomMessage && isCompanionText(roomId, queued, key),
    )
  ) {
    return true;
  }
  const encrypted = queuedEvents.filter((queued) => queued.type === EventType.RoomMessageEncrypted);
  if (encrypted.length === 0) {
    return false;
  }
  const hydrated = params.hydrateEvents
    ? await params.hydrateEvents(roomId, encrypted).catch(() => [])
    : [];
  return encrypted.some((envelope, index) => {
    const decrypted = hydrated[index];
    if (
      decrypted &&
      decrypted.type !== EventType.RoomMessageEncrypted &&
      !getMatrixEventProjection(decrypted)?.decryptionFailure
    ) {
      return (
        decrypted.type === EventType.RoomMessage &&
        !isIgnoredByHandler(decrypted, selfUserId) &&
        isCompanionText(roomId, decrypted, key)
      );
    }
    // Not decryptable yet: the thread relation stays in clear on the envelope.
    const relation = asRoomMessageContent(envelope);
    const envelopeKey = `${roomId}\0${resolveMatrixThreadRootId(relation) ?? ""}`;
    return envelopeKey === key;
  });
}

/**
 * Wrap the ingress dispatch so a captionless attachment waits up to `holdMs` for
 * the sender's next text in the same room and thread. Any other message in that
 * conversation, a second attachment, a control command or the deadline dispatches
 * the held attachment alone first, exactly as without the hold.
 */
export function createMatrixMediaHold(params: {
  holdMs: number;
  selfUserId: string;
  dispatch: MatrixRoomMessageDispatch;
  /** Decrypts queued companion candidates; without it, ciphertext counts by its envelope. */
  hydrateEvents?: MatrixHoldEventHydrator;
  /** The handler's own control-command decision for a text event (mention-stripped). */
  isControlCommand: (roomId: string, event: MatrixRawEvent) => Promise<boolean>;
  /**
   * Whether the reaction handler could act on this reaction at all (approval
   * reactions and reaction notifications both target the bot's own messages).
   */
  reactionMayStartWork: (roomId: string, event: MatrixRawEvent) => Promise<boolean>;
  logVerboseMessage: (message: string) => void;
  now?: () => number;
}) {
  const { holdMs } = params;
  const now = params.now ?? Date.now;
  const heldByKey = new Map<string, HoldEntry>();
  // The hold is measured from when the attachment was sent, so a replay after a
  // restart keeps the original deadline instead of starting a new window.
  const remainingHoldMs = (event: MatrixRawEvent) => {
    const age = now() - event.origin_server_ts;
    return Number.isFinite(age) ? Math.max(0, Math.min(holdMs, holdMs - age)) : holdMs;
  };
  // Flushes that have left the hold but whose turn is not yet admitted, per room.
  const admittingByRoom = new Map<string, Set<Promise<void>>>();
  // Sync batches whose events are still being admitted one by one. The drain can
  // deliver a batch's first event before the rest is durable, so a replayed
  // attachment also looks here for the text that follows it.
  const admittingBatches = new Set<readonly MatrixHoldSyncBatchEvent[]>();
  let closed = false;

  const batchEventsFor = (roomId: string) =>
    Array.from(admittingBatches).flatMap((batch) =>
      batch.filter((entry) => entry.roomId === roomId).map((entry) => entry.event),
    );

  const trackAdmission = (roomId: string, admission: Promise<void>) => {
    const pending = admittingByRoom.get(roomId) ?? new Set<Promise<void>>();
    pending.add(admission);
    admittingByRoom.set(roomId, pending);
    const untrack = () => {
      pending.delete(admission);
      if (pending.size === 0 && admittingByRoom.get(roomId) === pending) {
        admittingByRoom.delete(roomId);
      }
    };
    void admission.then(untrack, untrack);
  };

  const forget = (entry: HoldEntry) => {
    if (heldByKey.get(entry.key) === entry) {
      heldByKey.delete(entry.key);
    }
    if (entry.heartbeat) {
      clearInterval(entry.heartbeat);
      entry.heartbeat = undefined;
    }
    if (entry.onAbort) {
      entry.lifecycle.abortSignal.removeEventListener("abort", entry.onAbort);
      entry.onAbort = undefined;
    }
  };

  const debouncer = createInboundDebouncer<HoldEntry>({
    debounceMs: holdMs,
    // The window is measured from the attachment; a joining text never extends it.
    maxWaitMs: (entry) =>
      entry.kind === "media" ? (entry.windowMs ?? remainingHoldMs(entry.event)) : holdMs,
    buildKey: (entry) => entry.key,
    shouldDebounce: (entry) => entry.kind !== "other",
    resolveDebounceMs: (entry, pending) =>
      entry.kind === "media"
        ? (entry.windowMs ?? remainingHoldMs(entry.event))
        : entry.kind === "text" && pending
          ? holdMs
          : 0,
    // Only the held attachment's own sender can complete it; anything else in the
    // conversation dispatches it first so delivery order is preserved.
    // A replay after downtime drains old events back to back, so the text must
    // also have been sent within the hold window of the attachment, by server time.
    canAppend: (entry, pending) =>
      entry.kind === "text" &&
      pending.length === 1 &&
      pending[0]?.kind === "media" &&
      pending[0].event.sender === entry.event.sender &&
      isWithinHoldWindow(pending[0].event, entry.event, holdMs),
    onFlush: (entries, createFlush) => {
      for (const entry of entries) {
        forget(entry);
      }
      const [first, second] = entries;
      const { lifecycle, settle, abandon } = fanInChannelIngressLifecycles(
        entries.map((entry) => entry.lifecycle),
      );
      const flush = createFlush({
        lifecycle,
        dispatch: async (admissionLifecycle) => {
          if (!first) {
            return;
          }
          const event = second ? mergeMatrixMediaCaption(first.event, second.event) : first.event;
          if (second) {
            params.logVerboseMessage(
              `matrix: media hold joined room=${first.roomId} media=${first.event.event_id} text=${second.event.event_id}`,
            );
          }
          try {
            await params.dispatch(first.roomId, event, {
              ...admissionLifecycle,
              admission: "exclusive",
              onCancelled: lifecycle?.onCancelled,
            });
            // A turn the handler dropped before adoption still consumed every claim.
            await settle();
          } catch (error) {
            await abandon(error);
            throw error;
          }
        },
      });
      if (first) {
        trackAdmission(first.roomId, flush.admission);
      }
      return flush;
    },
    onError: (error, entries) => {
      params.logVerboseMessage(
        `matrix: media hold flush failed room=${entries[0]?.roomId ?? "unknown"}: ${String(error)}`,
      );
    },
    onCancel: (entries) => {
      for (const entry of entries) {
        forget(entry);
        if (entry.lifecycle.abortSignal.aborted) {
          continue;
        }
        // Ownership ends before any turn: reopen the claim for the next start. The
        // drain keeps a claim whose release failed, so log and move on.
        void Promise.resolve(
          entry.lifecycle.onCancelled?.() ?? entry.lifecycle.onAbandoned(),
        ).catch((error: unknown) => {
          params.logVerboseMessage(
            `matrix: media hold could not reopen claim room=${entry.roomId} id=${entry.event.event_id}: ${String(error)}`,
          );
        });
      }
    },
  });

  const hold = (entry: HoldEntry) => {
    heldByKey.set(entry.key, entry);
    const intervalMs = entry.lifecycle.deferredHeartbeatIntervalMs;
    if (intervalMs !== undefined && intervalMs > 0 && entry.lifecycle.onDeferredHeartbeat) {
      entry.heartbeat = setInterval(() => entry.lifecycle.onDeferredHeartbeat?.(), intervalMs);
      entry.heartbeat.unref?.();
    }
    // The drain ends ownership (stop, stall) by aborting; drop the attachment so a
    // later flush cannot start a turn for a claim this process no longer owns.
    entry.onAbort = () => {
      if (heldByKey.get(entry.key) === entry) {
        debouncer.cancelKey(entry.key);
      }
      forget(entry);
    };
    entry.lifecycle.abortSignal.addEventListener("abort", entry.onAbort, { once: true });
  };

  const onRoomMessage: MatrixRoomMessageDispatch = async (roomId, event, lifecycle) => {
    const kind = closed ? undefined : classifyHoldKind(event, params.selfUserId);
    if (!kind) {
      return await params.dispatch(roomId, event, lifecycle);
    }
    if (kind === "reaction") {
      // A reaction to a held attachment, or one the reaction handler would ignore,
      // starts no work and must not release the hold. Otherwise the reaction's
      // thread is only known once its target is fetched, so it cannot be keyed:
      // release every attachment held in the room, and let attachments already on
      // their way to a turn be admitted, before it goes on.
      const targetId = resolveReactionTargetId(event);
      const targetsHeld = Array.from(heldByKey.values()).some(
        (held) => held.roomId === roomId && held.event.event_id === targetId,
      );
      if (!targetsHeld && (await params.reactionMayStartWork(roomId, event))) {
        await Promise.all(
          Array.from(heldByKey.values())
            .filter((held) => held.roomId === roomId)
            .map((held) => debouncer.flushKey(held.key)),
        );
        await Promise.allSettled(Array.from(admittingByRoom.get(roomId) ?? []));
      }
      return await params.dispatch(roomId, event, lifecycle);
    }
    const key = `${roomId}\0${resolveMatrixThreadRootId(asRoomMessageContent(event)) ?? ""}`;
    const entry: HoldEntry = { roomId, event, lifecycle, key, kind };
    if (kind === "media" && remainingHoldMs(event) <= 0) {
      // A replayed attachment whose window has passed goes straight on, unless the
      // text that belongs to it is already queued behind it in the same lane (an
      // outage longer than the hold): then it waits for that text, which the lane
      // delivers next, so recovery still produces one turn.
      if (
        await hasQueuedCompanionText({
          roomId,
          media: event,
          key,
          lifecycle,
          holdMs,
          selfUserId: params.selfUserId,
          batchEvents: batchEventsFor(roomId),
          hydrateEvents: params.hydrateEvents,
        })
      ) {
        entry.windowMs = holdMs;
      } else {
        entry.kind = "other";
      }
    }
    if (entry.kind === "media") {
      hold(entry);
      void debouncer.enqueue(entry);
      // The claim stays with the attachment while it waits; deferring frees the room lane.
      return { kind: "deferred" };
    }
    const pending = heldByKey.get(key);
    if (
      kind === "text" &&
      pending?.event.sender === event.sender &&
      (await params.isControlCommand(roomId, event))
    ) {
      entry.kind = "other";
    }
    // A joining text completes the pair at once; anything else dispatches the held
    // attachment first and then itself, each under its own claim.
    await debouncer.enqueue(entry);
    await debouncer.flushKey(key);
  };

  /** Stop holding: reopen every held claim so the next start delivers it again. */
  const close = () => {
    closed = true;
    // Cancelling forgets entries, so iterate over a snapshot.
    for (const entry of Array.from(heldByKey.values())) {
      debouncer.cancelKey(entry.key);
    }
  };

  /**
   * Make a sync batch visible to the companion lookup while its events are being
   * admitted; call the returned function once the whole batch is durable.
   */
  const noteSyncBatch = (events: readonly MatrixHoldSyncBatchEvent[]) => {
    if (events.length === 0) {
      return () => {};
    }
    admittingBatches.add(events);
    return () => {
      admittingBatches.delete(events);
    };
  };

  return { onRoomMessage, noteSyncBatch, close };
}
