export type RuntimeTranscriptRole = "user" | "assistant" | "tool" | "toolResult";

export type RuntimeTranscriptRecord = {
  message: Record<string, unknown>;
  role: RuntimeTranscriptRole;
};

export type RuntimeTranscriptToolCall = {
  name: string;
  args: unknown;
  id?: string;
};

export type RuntimeTranscriptSummary = {
  finalText: string;
  toolCalls: RuntimeTranscriptToolCall[];
  hasDirectReplySelfMessage: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeTranscriptRole(value: string | undefined): RuntimeTranscriptRole | undefined {
  if (value === "user" || value === "assistant" || value === "tool" || value === "toolResult") {
    return value;
  }
  if (value === "tool_result" || value === "tool-result") {
    return "toolResult";
  }
  return undefined;
}

function normalizeToolCallId(value: unknown) {
  return readNonEmptyString(value);
}

function extractMessageText(message: Record<string, unknown>) {
  const rawContent = message.content;
  if (typeof rawContent === "string") {
    return rawContent.trim();
  }
  if (!Array.isArray(rawContent)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of rawContent) {
    if (typeof block === "string") {
      if (block.trim()) {
        parts.push(block.trim());
      }
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }
    const text = readNonEmptyString(block.text);
    if (text) {
      parts.push(text);
      continue;
    }
    const nestedText = readNonEmptyString(block.content);
    if (
      nestedText &&
      (block.type === "output_text" || block.type === "text" || block.type === "message")
    ) {
      parts.push(nestedText);
    }
  }
  return parts.join("\n").trim();
}

function parseJsonArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function normalizeRuntimeTranscriptText(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

export function buildRuntimeTranscriptRecords(transcriptBytes: string): RuntimeTranscriptRecord[] {
  const records: RuntimeTranscriptRecord[] = [];
  for (const line of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const message = isRecord(parsed.message) ? parsed.message : undefined;
      const role = normalizeTranscriptRole(readNonEmptyString(message?.role));
      if (!message || !role) {
        continue;
      }
      records.push({
        message,
        role,
      });
    } catch {
      // Ignore malformed QA transcript rows and keep scanner output deterministic.
    }
  }
  return records;
}

export function extractRuntimeFinalAssistantText(records: RuntimeTranscriptRecord[]) {
  let lastAssistantText = "";
  for (const record of records) {
    if (record.role !== "assistant") {
      continue;
    }
    const text = extractMessageText(record.message);
    if (text) {
      lastAssistantText = text;
    }
  }
  return lastAssistantText.trim();
}

export function extractRuntimeAssistantToolCalls(
  records: RuntimeTranscriptRecord[],
): RuntimeTranscriptToolCall[] {
  const calls: RuntimeTranscriptToolCall[] = [];
  for (const record of records) {
    if (record.role !== "assistant") {
      continue;
    }
    const rawContent = record.message.content;
    if (Array.isArray(rawContent)) {
      for (const block of rawContent) {
        if (!isRecord(block)) {
          continue;
        }
        const type = readNonEmptyString(block.type)?.toLowerCase();
        if (type !== "tool_use" && type !== "toolcall" && type !== "tool_call") {
          continue;
        }
        calls.push({
          name: readNonEmptyString(block.name) ?? "unknown",
          args: parseJsonArguments(
            block.input ?? block.arguments ?? block.args ?? block.payload ?? null,
          ),
          ...(normalizeToolCallId(block.id) ||
          normalizeToolCallId(block.toolCallId) ||
          normalizeToolCallId(block.toolUseId)
            ? {
                id:
                  normalizeToolCallId(block.id) ??
                  normalizeToolCallId(block.toolCallId) ??
                  normalizeToolCallId(block.toolUseId),
              }
            : {}),
        });
      }
    }
    const rawToolCalls =
      record.message.tool_calls ??
      record.message.toolCalls ??
      record.message.function_call ??
      record.message.functionCall;
    const toolCalls = Array.isArray(rawToolCalls)
      ? rawToolCalls
      : rawToolCalls
        ? [rawToolCalls]
        : [];
    for (const call of toolCalls) {
      if (!isRecord(call)) {
        continue;
      }
      const functionRecord = isRecord(call.function) ? call.function : undefined;
      const name = readNonEmptyString(call.name) ?? readNonEmptyString(functionRecord?.name);
      calls.push({
        name: name ?? "unknown",
        args: parseJsonArguments(
          call.arguments ??
            functionRecord?.arguments ??
            call.input ??
            functionRecord?.input ??
            null,
        ),
        ...(normalizeToolCallId(call.id) ||
        normalizeToolCallId(call.toolCallId) ||
        normalizeToolCallId(call.toolUseId)
          ? {
              id:
                normalizeToolCallId(call.id) ??
                normalizeToolCallId(call.toolCallId) ??
                normalizeToolCallId(call.toolUseId),
            }
          : {}),
      });
    }
  }
  return calls;
}

function isMessageSendCall(call: RuntimeTranscriptToolCall) {
  if (call.name !== "message") {
    return false;
  }
  if (!isRecord(call.args) || readNonEmptyString(call.args.action)?.toLowerCase() !== "send") {
    return false;
  }
  const explicitTarget =
    readNonEmptyString(call.args.conversationId) ??
    readNonEmptyString(call.args.conversation) ??
    readNonEmptyString(call.args.to) ??
    readNonEmptyString(call.args.target);
  if (!explicitTarget) {
    return true;
  }
  return /\b(?:current|same-chat|qa-operator|dm:qa-operator)\b/iu.test(explicitTarget);
}

export function summarizeRuntimeTranscript(transcriptBytes: string): RuntimeTranscriptSummary {
  const records = buildRuntimeTranscriptRecords(transcriptBytes);
  const finalText = extractRuntimeFinalAssistantText(records);
  const toolCalls = extractRuntimeAssistantToolCalls(records);
  return {
    finalText,
    toolCalls,
    hasDirectReplySelfMessage:
      toolCalls.some(isMessageSendCall) &&
      normalizeRuntimeTranscriptText(finalText).toLowerCase() === "sent.",
  };
}

export function isHeartbeatOnlyRuntimeTranscript(transcriptBytes: string) {
  const records = buildRuntimeTranscriptRecords(transcriptBytes);
  if (records.length === 0 || records.length > 2) {
    return false;
  }
  if (extractRuntimeAssistantToolCalls(records).length > 0) {
    return false;
  }
  const userText = records
    .filter((record) => record.role === "user")
    .map((record) => extractMessageText(record.message))
    .join("\n");
  if (!/\bHEARTBEAT\.md\b/iu.test(userText)) {
    return false;
  }
  const finalText = normalizeRuntimeTranscriptText(extractRuntimeFinalAssistantText(records));
  return !finalText || finalText === "HEARTBEAT_OK";
}
