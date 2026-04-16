export { asNullableRecord as asRecord } from "openclaw/plugin-sdk/text-runtime";
export { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const ROLE_PREFIX_RE = /^(User|Assistant):\s*/;
const METADATA_BLOCK_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
  "System (untrusted metadata):",
  "System (untrusted):",
  "## Inbound Context (trusted metadata)",
] as const;
const INLINE_METADATA_TAG_RE = /\[\[\s*reply_to(?:_current|:[^[\]]+)\s*]]/i;
const JSON_METADATA_KEY_RE =
  /"(?:message_id|message_id_full|sender_id|chat_id|reply_to|reply_to_id|timestamp|thread_id)"\s*:/i;
const TEXT_METADATA_KEY_RE =
  /\b(?:message_id|message_id_full|sender_id|chat_id|reply_to|reply_to_id|thread_id)\s*[:=]/i;

export function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function includesSystemEventToken(cleanedBody: string, eventText: string): boolean {
  const normalizedBody = normalizeTrimmedString(cleanedBody);
  const normalizedEventText = normalizeTrimmedString(eventText);
  if (!normalizedBody || !normalizedEventText) {
    return false;
  }
  if (normalizedBody === normalizedEventText) {
    return true;
  }
  return normalizedBody.split(/\r?\n/).some((line) => line.trim() === normalizedEventText);
}

function isMetadataSentinelLine(line: string): boolean {
  const trimmed = line.trim();
  return METADATA_BLOCK_SENTINELS.some((sentinel) => sentinel === trimmed);
}

function extractMetadataWrapperPayload(text: string): string | null {
  const trimmed = text.trim();
  for (const sentinel of METADATA_BLOCK_SENTINELS) {
    if (!trimmed.startsWith(sentinel)) {
      continue;
    }
    return trimmed.slice(sentinel.length).trim();
  }
  return null;
}

function stripRolePrefix(text: string): { prefix: string; body: string } {
  const timestampStripped = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  const match = timestampStripped.match(ROLE_PREFIX_RE);
  if (!match) {
    return { prefix: "", body: timestampStripped };
  }
  return { prefix: match[0], body: timestampStripped.slice(match[0].length) };
}

function normalizeSanitizedText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function stripInlineMetadataTag(line: string): string {
  const trimmed = line.trim();
  if (!INLINE_METADATA_TAG_RE.test(trimmed)) {
    return line;
  }
  if (trimmed.match(new RegExp(`^${INLINE_METADATA_TAG_RE.source}$`, "i"))) {
    return "";
  }
  return line.replace(
    new RegExp(`\\s+${INLINE_METADATA_TAG_RE.source}\\s*$`, "i"),
    "",
  );
}

function isStandaloneMetadataText(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }

  let matchedMetadataLine = false;
  for (const line of lines) {
    if (/^[{}[\],]+$/.test(line) || line === "```json" || line === "```") {
      continue;
    }
    if (JSON_METADATA_KEY_RE.test(line) || TEXT_METADATA_KEY_RE.test(line)) {
      matchedMetadataLine = true;
      continue;
    }
    return false;
  }

  return matchedMetadataLine;
}

export function sanitizeDreamingMetadataText(text: string): string {
  if (!text) {
    return text;
  }

  const { prefix, body } = stripRolePrefix(text);
  const lines = body.split(/\r?\n/);
  const result: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (isMetadataSentinelLine(trimmed)) {
      if ((lines[index + 1] ?? "").trim() === "```json") {
        index += 2;
        while (index < lines.length && (lines[index] ?? "").trim() !== "```") {
          index += 1;
        }
        continue;
      }
      continue;
    }
    if (trimmed === "```json" && JSON_METADATA_KEY_RE.test(lines[index + 1] ?? "")) {
      index += 1;
      while (index < lines.length && (lines[index] ?? "").trim() !== "```") {
        index += 1;
      }
      continue;
    }
    result.push(line);
  }

  let sanitized = result.join("\n");
  sanitized = sanitized
    .split(/\r?\n/)
    .map((line) => stripInlineMetadataTag(line))
    .filter((line) => line.trim().length > 0)
    .join("\n");
  sanitized = normalizeSanitizedText(sanitized);
  if (!sanitized) {
    return "";
  }
  return prefix ? `${prefix}${sanitized}` : sanitized;
}

export function isMetadataGarbageText(text: string): boolean {
  const normalized = normalizeTrimmedString(text);
  if (!normalized) {
    return false;
  }
  if (isStandaloneMetadataText(normalized)) {
    return true;
  }

  const wrapperPayload = extractMetadataWrapperPayload(normalized);
  if (wrapperPayload !== null) {
    if (!wrapperPayload) {
      return true;
    }
    if (isStandaloneMetadataText(wrapperPayload)) {
      return true;
    }
  }

  const sanitized = sanitizeDreamingMetadataText(normalized);
  const sanitizedNormalized = normalizeTrimmedString(sanitized);
  if (!sanitizedNormalized) {
    return true;
  }
  if (sanitizedNormalized !== normalized && isStandaloneMetadataText(sanitizedNormalized)) {
    return true;
  }
  return false;
}
