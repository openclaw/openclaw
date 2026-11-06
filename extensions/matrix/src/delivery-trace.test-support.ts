import { MatrixEvent, type IEvent } from "matrix-js-sdk/lib/matrix.js";
import type { WireRecorder } from "openclaw/plugin-sdk/channel-contract-testing";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import type { MatrixClient } from "./matrix/sdk.js";
import { installMatrixTestRuntime } from "./test-runtime.js";

const BOT_USER_ID = "@openclaw:example.org";

export function installMatrixDeliveryTraceRuntime() {
  // Real text/mention helpers keep rendered wire content in the lifecycle proof.
  installMatrixTestRuntime({
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: createPluginRuntimeMock().channel.inbound,
      text: {
        resolveMarkdownTableMode,
        convertMarkdownTables,
        resolveTextChunkLimit,
        resolveChunkMode,
        chunkMarkdownTextWithMode,
      },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: (text: string, patterns: RegExp[]) =>
          patterns.some((pattern) => pattern.test(text)),
        matchesMentionWithExplicit: () => false,
        implicitMentionKindWhen,
        resolveInboundMentionDecision,
      },
    } as unknown as PluginRuntime["channel"],
  });
}

export function createRecordingMatrixClient(recorder: WireRecorder): Partial<MatrixClient> {
  // Deterministic sequential event ids replace homeserver-minted opaque ids
  // (the normalizer seam from the trace spec, applied at the mock boundary):
  // every event on the wire consumes one id, so goldens show edits minting new
  // ids while their m.relates_to target stays the original event.
  const eventsById = new Map<string, IEvent>();
  let eventCount = 0;
  const mintEventId = () => {
    eventCount += 1;
    return `$e${eventCount}`;
  };
  const client: Partial<MatrixClient> = {
    getUserId: async () => BOT_USER_ID,
    prepareRoomForMessageSend: async () => "m.room.message",
    sendMessage: async (roomId: string, content: Record<string, unknown>) => {
      const eventId = mintEventId();
      // Snapshot before recording: edit flows reuse content structures, and the
      // recorder serializes at compare time.
      const payload = structuredClone(content);
      eventsById.set(eventId, {
        event_id: eventId,
        sender: BOT_USER_ID,
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: payload,
        unsigned: {},
      });
      recorder.recordWireCall({
        method: "sendMessage",
        target: roomId,
        payload,
        result: { event_id: eventId },
      });
      return eventId;
    },
    // Mention diffing and requested thread validation read the prior event;
    // quiet previews without a thread skip this otherwise unused round trip.
    getEvent: async (_roomId: string, eventId: string) => {
      recorder.recordWireCall({
        method: "getEvent",
        target: eventId,
        result: { found: eventsById.has(eventId) },
      });
      const event = eventsById.get(eventId);
      if (!event) {
        throw new Error(`Unknown recorded Matrix event: ${eventId}`);
      }
      return { ...structuredClone(event) };
    },
    getRelations: async (_roomId, eventId, relationType, eventType, opts) => {
      const originalEvent = eventsById.get(eventId);
      const events = [...eventsById.values()].filter((event) => {
        const relation = new MatrixEvent(event).getRelation();
        return (
          relation?.event_id === eventId &&
          relation.rel_type === relationType &&
          (!eventType || event.type === eventType) &&
          (relationType !== "m.replace" || event.sender === originalEvent?.sender)
        );
      });
      recorder.recordWireCall({
        method: "getRelations",
        target: eventId,
        payload: { relationType, eventType: eventType ?? null, limit: opts?.limit },
        result: { count: events.length },
      });
      return { originalEvent: originalEvent ?? null, events, nextBatch: null, prevBatch: null };
    },
    redactEvent: async (_roomId: string, eventId: string) => {
      // Redactions are events too: abandoning a draft consumes an event id.
      const redactionEventId = mintEventId();
      recorder.recordWireCall({
        method: "redactEvent",
        target: eventId,
        result: { event_id: redactionEventId },
      });
      return redactionEventId;
    },
    setTyping: async (roomId: string, typing: boolean, timeoutMs: number) => {
      recorder.recordWireCall({
        method: "setTyping",
        target: roomId,
        payload: { typing, timeoutMs },
      });
    },
    sendReadReceipt: async (_roomId: string, eventId: string) => {
      recorder.recordWireCall({ method: "sendReadReceipt", target: eventId });
    },
  };
  return client;
}
