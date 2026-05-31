import type { CallRecord } from "./types.js";

function redactObjectiveMetadata(metadata: CallRecord["metadata"]): CallRecord["metadata"] {
  if (!metadata || !Object.hasOwn(metadata, "objective")) {
    return metadata;
  }
  const { objective: _objective, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function redactCallRecordForRead(call: CallRecord): CallRecord {
  const metadata = redactObjectiveMetadata(call.metadata);
  return metadata === call.metadata ? call : { ...call, metadata };
}

export function redactCallRecordsForRead(calls: CallRecord[]): CallRecord[] {
  return calls.map(redactCallRecordForRead);
}

export function redactVoiceCallJsonLineForRead(line: string): string {
  try {
    const parsed = JSON.parse(line) as CallRecord;
    if (!parsed || typeof parsed !== "object" || !("callId" in parsed)) {
      return line;
    }
    return JSON.stringify(redactCallRecordForRead(parsed));
  } catch {
    return line;
  }
}
