import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function* readQaTranscriptMessages(transcriptBytes: string) {
  for (const line of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A malformed diagnostic row must not hide the remaining transcript.
      continue;
    }
    if (isRecord(parsed) && isRecord(parsed.message)) {
      yield parsed.message;
    }
  }
}

export function* readQaMessageFunctionCalls(message: Record<string, unknown>) {
  const raw =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  for (const call of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    if (!isRecord(call)) {
      continue;
    }
    const fn = isRecord(call.function) ? call.function : undefined;
    yield {
      id:
        normalizeOptionalString(call.id) ??
        normalizeOptionalString(call.toolCallId) ??
        normalizeOptionalString(call.toolUseId),
      tool: normalizeOptionalString(call.name) ?? normalizeOptionalString(fn?.name),
      args: call.arguments ?? fn?.arguments ?? call.input ?? fn?.input ?? null,
    };
  }
}
