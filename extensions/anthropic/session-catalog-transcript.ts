import {
  isRecord,
  normalizeBoundedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_TRANSCRIPT_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_TEXT_LENGTH = 1_000_000;

export type ClaudeTranscriptItem = {
  type: string;
  text?: string;
  content?: unknown;
  timestamp?: string;
  model?: string;
  uuid?: string;
  resumeCursor?: string;
  truncated?: true;
};

function transcriptItemType(role: string, content: unknown): string {
  if (!Array.isArray(content)) {
    return role === "user" ? "userMessage" : "agentMessage";
  }
  const types = content.flatMap((block) =>
    isRecord(block) && typeof block.type === "string" ? [block.type] : [],
  );
  if (types.length > 0 && types.every((type) => type === "tool_result")) {
    return "toolResult";
  }
  if (types.length > 0 && types.every((type) => type === "tool_use")) {
    return "toolCall";
  }
  if (types.length > 0 && types.every((type) => type === "thinking")) {
    return "reasoning";
  }
  return role === "user" ? "userMessage" : "agentMessage";
}

export function collectTranscriptText(value: unknown, fragments: string[]): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.trim()) {
        fragments.push(current);
      }
    } else if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push(current[index]);
      }
    } else if (isRecord(current)) {
      // LIFO traversal preserves the original text, thinking, content, input order.
      for (const key of ["input", "content", "thinking", "text"]) {
        pending.push(current[key]);
      }
    }
  }
}

export function parseTranscriptLine(line: Buffer): ClaudeTranscriptItem | undefined {
  const raw = safeParseJson<unknown>(line.toString("utf8"));
  if (!isRecord(raw) || raw.isSidechain === true || raw.isMeta === true || !isRecord(raw.message)) {
    return undefined;
  }
  const role = raw.message.role;
  if ((role !== "user" && role !== "assistant") || raw.type !== role) {
    return undefined;
  }
  const content = raw.message.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    return undefined;
  }
  const fragments: string[] = [];
  collectTranscriptText(content, fragments);
  const text = [...new Set(fragments)].join("\n\n");
  const timestamp = normalizeBoundedOptionalString(raw.timestamp, 128);
  const model = normalizeBoundedOptionalString(raw.message.model, 256);
  const uuid = normalizeBoundedOptionalString(raw.uuid, 256);
  const item: ClaudeTranscriptItem = {
    type: transcriptItemType(role, content),
    ...(text ? { text } : {}),
    content,
    ...(timestamp ? { timestamp } : {}),
    ...(model ? { model } : {}),
    ...(uuid ? { uuid } : {}),
  };
  try {
    if (Buffer.byteLength(JSON.stringify(item), "utf8") <= MAX_TRANSCRIPT_ITEM_BYTES) {
      return item;
    }
  } catch {
    // Parsed JSON can exceed the serializer's stack; retain text and metadata below.
  }
  delete item.content;
  item.text = `${truncateUtf16Safe(text, MAX_TRANSCRIPT_TEXT_LENGTH)}\n\n[oversized or deeply nested Claude item truncated]`;
  item.truncated = true;
  return item;
}
