import type { TalkEvent } from "openclaw/plugin-sdk/realtime-voice";
import type { CallRecord } from "../types.js";

export function appendRecentTalkEventMetadata(
  metadata: CallRecord["metadata"],
  event: TalkEvent,
): CallRecord["metadata"] {
  const previous = metadata ?? {};
  const recent = Array.isArray(previous.recentTalkEvents) ? previous.recentTalkEvents : [];
  return {
    ...previous,
    lastTalkEventAt: event.timestamp,
    lastTalkEventType: event.type,
    recentTalkEvents: [
      ...recent,
      {
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
      },
    ].slice(-12),
  };
}
