import type { TalkEvent } from "openclaw/plugin-sdk/realtime-voice";
import {
  asFiniteNumber,
  asRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type FaceTimeTalkEventSummary = {
  type: string;
  turnId?: string;
  callId?: string;
  final?: boolean;
  byteLength?: number;
  name?: string;
  text?: string;
  message?: string;
};

export function summarizeRecentTalkEvents(events: readonly TalkEvent[]) {
  return events.slice(-12).map((event): FaceTimeTalkEventSummary => {
    const payload = asRecord(event.payload);
    return {
      type: event.type,
      turnId: normalizeOptionalString(event.turnId),
      callId: normalizeOptionalString(event.callId),
      final: event.final,
      byteLength: asFiniteNumber(payload.byteLength),
      name: normalizeOptionalString(payload.name),
      text: normalizeOptionalString(payload.text),
      message: normalizeOptionalString(payload.message),
    };
  });
}
