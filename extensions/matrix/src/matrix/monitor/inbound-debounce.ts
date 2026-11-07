// Matrix inbound burst debouncing (`messages.inbound.byChannel.matrix` / `debounceMs`).
// Durable ingress hands each room event here with its claim lifecycle. Contiguous plain text
// from one sender and thread merges into one turn; everything else dispatches alone, in order.
import {
  createChannelInboundDebouncer,
  resolveInboundDebounceMs,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type {
  ChannelIngressMonitorDeliveryResult,
  ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { asNullableObjectRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CoreConfig } from "../../types.js";
import { stripMatrixMentionPrefix } from "./mentions.js";
import { EventType, type MatrixRawEvent } from "./types.js";

/** Claim lifecycle for one dispatch; a merged burst fans in every event's claim. */
export type MatrixInboundLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

type MatrixInboundDebounceEntry = {
  roomId: string;
  event: MatrixRawEvent;
  lifecycle: MatrixInboundLifecycle;
  /** Text after the handler's mention-prefix normalization; decides command bypass. */
  commandCheckText?: string;
};

/** Inputs the handler's mention-prefix normalizer uses for this event. */
export type MatrixCommandPrefixInputs = { displayName?: string; mentionRegexes: RegExp[] };

const MATRIX_HTML_FORMAT = "org.matrix.custom.html";

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

function readThreadRootId(event: MatrixRawEvent): string {
  const relation = asNullableObjectRecord(event.content["m.relates_to"]);
  return relation?.rel_type === "m.thread" ? (readStringValue(relation.event_id) ?? "") : "";
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

export function createMatrixInboundDebouncer(params: {
  /** Live runtime config; read at use time so debounce changes apply without reconnecting. */
  readConfig: () => CoreConfig;
  selfUserId: string;
  dispatch: (
    roomId: string,
    event: MatrixRawEvent,
    lifecycle: MatrixInboundLifecycle,
  ) => Promise<void>;
  logVerboseMessage: (message: string) => void;
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

  const pending = new Set<MatrixInboundDebounceEntry>();
  const cancellationSettlements: Promise<void>[] = [];
  const shutdown = new AbortController();
  const cancelEntries = (entries: readonly MatrixInboundDebounceEntry[]) =>
    fanInChannelIngressLifecycles(entries.map((entry) => entry.lifecycle)).cancel();

  // One room reserves the ingress lane's admission order; only contiguous same-sender/thread
  // text merges, so a burst never jumps ahead of another sender's message.
  const { debouncer } = createChannelInboundDebouncer<MatrixInboundDebounceEntry>({
    cfg: readConfig(),
    channel: "matrix",
    resolveDebounceMs: () => resolveInboundDebounceMs({ cfg: readConfig(), channel: "matrix" }),
    buildKey: ({ roomId }) => `matrix:${roomId}`,
    canAppend: (entry, entries) => {
      const last = entries.at(-1);
      return (
        last?.event.sender === entry.event.sender &&
        readThreadRootId(last.event) === readThreadRootId(entry.event)
      );
    },
    serializeImmediate: true,
    shouldDebounce: ({ event, commandCheckText }) =>
      isTextMessage(event) &&
      Boolean(event.sender) &&
      event.sender !== selfUserId &&
      isPlainNewMessage(event) &&
      shouldDebounceTextInbound({ text: commandCheckText, cfg: readConfig() }),
    onFlush: (entries, createFlush) => {
      for (const entry of entries) {
        pending.delete(entry);
      }
      const { lifecycle, settle, cancel } = fanInChannelIngressLifecycles(
        entries.map((entry) => entry.lifecycle),
      );
      return createFlush({
        lifecycle,
        dispatch: async (admissionLifecycle) => {
          const last = entries.at(-1);
          if (!last || shutdown.signal.aborted || admissionLifecycle.abortSignal.aborted) {
            await cancel();
            return;
          }
          let event = last.event;
          if (entries.length > 1) {
            event = mergeMatrixInboundBurst(
              entries.map((entry) => entry.event),
              last.event,
            );
            logVerboseMessage(
              `matrix: debounce merged ${entries.length} events room=${last.roomId} into id=${event.event_id ?? "unknown"}`,
            );
          }
          await params.dispatch(last.roomId, event, admissionLifecycle);
          // Gated events (dropped, unauthorized) end without adopting; settle their claims.
          if (shutdown.signal.aborted || admissionLifecycle.abortSignal.aborted) {
            await cancel();
          } else {
            await settle();
          }
        },
      });
    },
    onError: params.onError,
    onCancel: (entries) => {
      for (const entry of entries) {
        pending.delete(entry);
      }
      const settlement = cancelEntries(entries);
      cancellationSettlements.push(settlement);
      void settlement.catch(params.onError);
    },
  });

  /** Normalize like the handler does, so "@Bot: /stop" bypasses batching too. */
  const resolveCommandCheckText = async (roomId: string, event: MatrixRawEvent) => {
    if (!isTextMessage(event)) {
      return undefined;
    }
    const inputs = await params.resolveCommandPrefixInputs(roomId, event);
    return stripMatrixMentionPrefix({ text: readTextBody(event), userId: selfUserId, ...inputs });
  };

  // Prefix resolution is async; queue it per room so a burst still reaches the debouncer in
  // arrival order. Each task ends once its item is registered, not when its turn finishes.
  const ingressQueue = new KeyedAsyncQueue();

  const enqueue = async (
    roomId: string,
    event: MatrixRawEvent,
    lifecycle: MatrixInboundLifecycle,
  ): Promise<ChannelIngressMonitorDeliveryResult> => {
    // Claims settle through lifecycle callbacks, so terminal flush errors spend the
    // drain's bounded retry budget before dead-lettering.
    if (shutdown.signal.aborted || lifecycle.abortSignal.aborted) {
      await cancelEntries([{ roomId, event, lifecycle }]);
      return { kind: "deferred" };
    }
    const { enqueued } = await ingressQueue.enqueue(roomId, async () => {
      // A failed lookup leaves no command text, which dispatches the event on its own.
      const commandCheckText = await resolveCommandCheckText(roomId, event).catch(() => "");
      const entry = { roomId, event, lifecycle, commandCheckText };
      pending.add(entry);
      return {
        enqueued: debouncer.enqueue(entry).catch((error: unknown) => {
          pending.delete(entry);
          throw error;
        }),
      };
    });
    await enqueued;
    return { kind: "deferred" };
  };

  /** Stop admitting work: pending bursts and later deliveries return to the durable queue. */
  const close = () => {
    shutdown.abort();
    for (const roomId of new Set([...pending].map((entry) => entry.roomId))) {
      debouncer.cancelKey(`matrix:${roomId}`);
    }
  };

  /** Close, then wait for in-flight flushes and claim cancellations. */
  const stop = async () => {
    close();
    const results = await Promise.allSettled([debouncer.drain()]);
    results.push(...(await Promise.allSettled(cancellationSettlements)));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Matrix inbound debounce shutdown failed.");
    }
  };

  return { enqueue, close, stop };
}
