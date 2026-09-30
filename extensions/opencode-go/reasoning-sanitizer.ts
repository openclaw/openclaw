import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const REASONING_REPLAY_FIELDS = [
  "reasoning_details",
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function isReasoningReplayPart(value: unknown): boolean {
  const type = asOptionalObjectRecord(value)?.type;
  return type === "thinking" || type === "redacted_thinking" || type === "reasoning";
}

function stripReasoningReplayFields(value: unknown): void {
  const record = asOptionalObjectRecord(value);
  if (!record) {
    return;
  }
  for (const field of REASONING_REPLAY_FIELDS) {
    delete record[field];
  }

  const content = record.content;
  if (Array.isArray(content)) {
    const nextContent = stripReasoningReplayItems(content);
    record.content =
      nextContent.length > 0
        ? nextContent
        : [{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }];
  }
}

function stripReasoningReplayItems(items: unknown[]): unknown[] {
  const retained = [];
  for (const item of items) {
    if (!isReasoningReplayPart(item)) {
      stripReasoningReplayFields(item);
      retained.push(item);
    }
  }
  return retained;
}

export function stripOpencodeGoKimiReasoningPayload(payloadObj: Record<string, unknown>): void {
  stripReasoningReplayFields(payloadObj);
  delete payloadObj.reasoning_effort;
  delete payloadObj.reasoningEffort;
  for (const key of ["messages", "input"] as const) {
    if (Array.isArray(payloadObj[key])) {
      payloadObj[key] = stripReasoningReplayItems(payloadObj[key]);
    }
  }
}
