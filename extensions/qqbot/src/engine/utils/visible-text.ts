import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";

const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
] as const;

function isInboundMetaSentinelLine(line: string): boolean {
  const trimmed = line.trim();
  return INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed);
}

function findRawJsonObjectEnd(lines: string[], start: number): number {
  let depth = 0;
  let sawBrace = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const char of line) {
      if (char === "{") {
        depth += 1;
        sawBrace = true;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (sawBrace && depth <= 0) {
      return index + 1;
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
    return index < lines.length ? index + 1 : start;
  }

  if ((lines[index] ?? "").trim().startsWith("{")) {
    const end = findRawJsonObjectEnd(lines, index);
    return end > index ? end : start;
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
