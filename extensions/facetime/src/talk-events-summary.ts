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

export function summarizeRecentTalkEvents(events: readonly unknown[]) {
  return events.slice(-12).map((event): FaceTimeTalkEventSummary => {
    const record = asRecord(event);
    const payload = asRecord(record.payload);
    return {
      type: normalizeOptionalString(record.type) ?? "unknown",
      turnId: normalizeOptionalString(record.turnId),
      callId: normalizeOptionalString(record.callId),
      final: typeof record.final === "boolean" ? record.final : undefined,
      byteLength: asFiniteNumber(payload.byteLength),
      name: normalizeOptionalString(payload.name),
      text: normalizeOptionalString(payload.text),
      message: normalizeOptionalString(payload.message),
    };
  });
}
