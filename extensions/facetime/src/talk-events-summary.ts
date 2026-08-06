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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function summarizeRecentTalkEvents(events: readonly unknown[], limit = 12) {
  return events.slice(-limit).map((event): FaceTimeTalkEventSummary => {
    const record = asRecord(event);
    const payload = asRecord(record.payload);
    return {
      type: optionalString(record.type) ?? "unknown",
      turnId: optionalString(record.turnId),
      callId: optionalString(record.callId),
      final: typeof record.final === "boolean" ? record.final : undefined,
      byteLength: optionalNumber(payload.byteLength),
      name: optionalString(payload.name),
      text: optionalString(payload.text),
      message: optionalString(payload.message),
    };
  });
}
