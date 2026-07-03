import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";

const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Reply chain of current user message (untrusted, nearest first):",
  "Reply target of current user message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Location (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

function isInboundMetaSentinelLine(line: string): boolean {
  const trimmed = line.trim();
  return INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed);
}

function findRawJsonValueEnd(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    const candidate = lines.slice(start, index + 1).join("\n");
    try {
      JSON.parse(candidate);
      return index + 1;
    } catch {
      // Keep reading until the echoed raw JSON value is complete.
    }
  }
  return start;
}

function skipOneInboundMetaBlock(lines: string[], start: number): number {
  if (!isInboundMetaSentinelLine(lines[start] ?? "")) {
    return start;
  }

  let index = start + 1;
  while (index < lines.length && (lines[index] ?? "").trim() === "") {
    index += 1;
  }

  if ((lines[index] ?? "").trim() === "```json") {
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() !== "```") {
      index += 1;
    }
    return index < lines.length ? index + 1 : lines.length;
  }

  const rawJsonStart = (lines[index] ?? "").trimStart();
  if (rawJsonStart.startsWith("{") || rawJsonStart.startsWith("[")) {
    const end = findRawJsonValueEnd(lines, index);
    return end > index ? end : lines.length;
  }

  return start;
}

function stripLeadingInboundMetadataBlocks(text: string): string {
  if (!text || !INBOUND_META_SENTINELS.some((sentinel) => text.includes(sentinel))) {
    return text;
  }

  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") {
    index += 1;
  }

  let changed = false;
  while (index < lines.length) {
    const next = skipOneInboundMetaBlock(lines, index);
    if (next === index) {
      break;
    }
    changed = true;
    index = next;
    while (index < lines.length && (lines[index] ?? "").trim() === "") {
      index += 1;
    }
  }

  return changed ? lines.slice(index).join("\n").trim() : text;
}

export function sanitizeQQBotVisibleText(text: string): string {
  return stripLeadingInboundMetadataBlocks(sanitizeAssistantVisibleText(text));
}
