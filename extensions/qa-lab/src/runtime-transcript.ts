import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function extractQaContentText(
  rawContent: unknown,
  readBlockText: (block: Record<string, unknown>) => string | undefined,
) {
  if (typeof rawContent === "string") {
    return rawContent.trim();
  }
  if (!Array.isArray(rawContent)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of rawContent) {
    const text =
      typeof block === "string" ? block.trim() : isRecord(block) ? readBlockText(block) : undefined;
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

export function extractQaMessageText(
  message: Record<string, unknown>,
  acceptsNestedType: (type: unknown) => boolean,
) {
  return extractQaContentText(message.content, (block) => {
    const text = normalizeOptionalString(block.text);
    if (text) {
      return text;
    }
    const nestedText = normalizeOptionalString(block.content);
    return nestedText && acceptsNestedType(block.type) ? nestedText : undefined;
  });
}

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

export function* readQaMessageToolCalls(
  message: Record<string, unknown>,
  options: { preferArguments?: boolean; includeFunctionCalls?: boolean } = {},
) {
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!isRecord(block)) {
      continue;
    }
    const type = normalizeOptionalString(block.type)?.toLowerCase();
    if (
      type !== "tool_use" &&
      type !== "toolcall" &&
      type !== "tool_call" &&
      !(options.includeFunctionCalls && type === "function_call")
    ) {
      continue;
    }
    yield {
      block,
      id:
        normalizeOptionalString(block.id) ??
        normalizeOptionalString(block.toolCallId) ??
        normalizeOptionalString(block.toolUseId),
      tool: normalizeOptionalString(block.name),
      args:
        (options.preferArguments
          ? (block.arguments ?? block.input)
          : (block.input ?? block.arguments)) ??
        block.args ??
        block.payload ??
        null,
    };
  }
  const raw =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  for (const call of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    if (!isRecord(call)) {
      continue;
    }
    const fn = isRecord(call.function) ? call.function : undefined;
    yield {
      block: undefined,
      id:
        normalizeOptionalString(call.id) ??
        normalizeOptionalString(call.toolCallId) ??
        normalizeOptionalString(call.toolUseId),
      tool: normalizeOptionalString(call.name) ?? normalizeOptionalString(fn?.name),
      args: call.arguments ?? fn?.arguments ?? call.input ?? fn?.input ?? null,
    };
  }
}
