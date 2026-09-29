// Opencode Go plugin module implements reasoning sanitizer behavior.
const REASONING_REPLAY_FIELDS = [
  "reasoning_details",
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function isReasoningReplayPart(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking" || type === "reasoning";
}

function stripReasoningReplayFields(value: unknown): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") {
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const field of REASONING_REPLAY_FIELDS) {
      delete record[field];
    }

    const content = record.content;
    if (Array.isArray(content)) {
      const nextContent = [];
      for (const part of content) {
        if (!isReasoningReplayPart(part)) {
          nextContent.push(part);
        }
      }
      record.content =
        nextContent.length > 0
          ? nextContent
          : [{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }];
      // Preserve traversal order without consuming a call frame per nested part.
      for (let index = nextContent.length - 1; index >= 0; index--) {
        pending.push(nextContent[index]);
      }
    }
  }
}

function stripReasoningReplayFieldsFromList(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const nextItems = [];

  for (const item of value) {
    if (isReasoningReplayPart(item)) {
      continue;
    }
    stripReasoningReplayFields(item);
    nextItems.push(item);
  }
  return nextItems;
}

export function stripOpencodeGoKimiReasoningPayload(payloadObj: Record<string, unknown>): void {
  stripReasoningReplayFields(payloadObj);
  delete payloadObj.reasoning_effort;
  delete payloadObj.reasoningEffort;
  if ("messages" in payloadObj) {
    payloadObj.messages = stripReasoningReplayFieldsFromList(payloadObj.messages);
  }
  if ("input" in payloadObj) {
    payloadObj.input = stripReasoningReplayFieldsFromList(payloadObj.input);
  }
}
