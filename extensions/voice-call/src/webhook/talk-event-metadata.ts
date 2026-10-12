import type { TalkEvent } from "openclaw/plugin-sdk/realtime-voice";
import type { CallRecord } from "../types.js";

export function appendRecentTalkEventMetadata(
  metadata: CallRecord["metadata"],
  event: TalkEvent,
  mode: "streaming" | "realtime",
): CallRecord["metadata"] {
  const previous = metadata ?? {};
  const recent = Array.isArray(previous.recentTalkEvents) ? previous.recentTalkEvents : [];
  const streaming = mode === "streaming";
  const retained = streaming
    ? recent.filter((entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : recent;
  // The two transports retain their existing history shapes and limits.
  const next = streaming
    ? { at: event.timestamp, type: event.type, sessionId: event.sessionId, turnId: event.turnId }
    : {
        id: event.id,
        brain: event.brain,
        mode: event.mode,
        provider: event.provider,
        seq: event.seq,
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        transport: event.transport,
        type: event.type,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.final !== undefined ? { final: event.final } : {}),
      };
  return {
    ...previous,
    lastTalkEventAt: event.timestamp,
    lastTalkEventType: event.type,
    recentTalkEvents: [...retained, next].slice(streaming ? -10 : -12),
  };
}
