import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getAiTransportHost } from "../host.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

const PROVIDER_TOOL_RESULT_MAX_CHARS = 8000;
const IMAGE_TOOL_RESULT_TYPES = new Set(["image", "image_url", "input_image"]);
const AUDIO_TOOL_RESULT_TYPES = new Set(["audio", "input_audio", "output_audio"]);
const MEDIA_ONLY_TOOL_RESULT_TYPES = new Set([
  ...IMAGE_TOOL_RESULT_TYPES,
  ...AUDIO_TOOL_RESULT_TYPES,
]);
const INLINE_DATA_URI_PATTERN =
  /(^|[^A-Za-z0-9_])data:([a-z][a-z0-9.+-]*\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^,;"'\s]+|;base64)*,[^\s"'<>)]+)/gi;
const MIME_KEY_CANDIDATES = [
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
  "contentType",
  "content_type",
];
const TEXTUAL_MIME_PATTERN =
  /^(?:text\/|application\/(?:json|ld\+json|x-ndjson|xml|javascript|x-www-form-urlencoded)|[^/]+\/[^+]+\+(?:json|xml)$)/i;
const OPAQUE_OR_BINARY_FIELD_RE = /^(?:blob|buffer|bytes|encrypted_content|encrypted_stdout)$/i;
const MISSING_IMAGE_PAYLOAD_TEXT = "[image omitted: missing payload]";
const MISSING_AUDIO_PAYLOAD_TEXT = "[audio omitted: missing payload]";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when a media-shaped content block carries recognizable payload data
 *  in one of the canonical or provider wire shapes. Payload-less media blocks
 *  are malformed husks that must not suppress tool-result text or be emitted
 *  as native media parts (provider APIs reject empty payloads). */
function hasMediaPayload(block: unknown): boolean {
  if (!isRecord(block)) {
    return false;
  }
  if (
    isNonEmptyString(block.data) ||
    isNonEmptyString(block.url) ||
    isNonEmptyString(block.file_id) ||
    isNonEmptyString(block.audio_url)
  ) {
    return true;
  }
  const imageUrl = block.image_url;
  if (isNonEmptyString(imageUrl) || (isRecord(imageUrl) && isNonEmptyString(imageUrl.url))) {
    return true;
  }
  const source = block.source;
  if (isRecord(source) && (isNonEmptyString(source.data) || isNonEmptyString(source.url))) {
    return true;
  }
  const inputAudio = block.input_audio;
  if (isNonEmptyString(inputAudio) || (isRecord(inputAudio) && isNonEmptyString(inputAudio.data))) {
    return true;
  }
  const audio = block.audio;
  if (isNonEmptyString(audio) || (isRecord(audio) && isNonEmptyString(audio.data))) {
    return true;
  }
  return false;
}

function readMimeType(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of MIME_KEY_CANDIDATES) {
    const mimeType = value[key];
    if (typeof mimeType === "string" && mimeType.trim().length > 0) {
      return mimeType;
    }
  }
  return undefined;
}

function isBinaryMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized ? !TEXTUAL_MIME_PATTERN.test(normalized) : false;
}

function describeOmittedValue(value: unknown, label: string): string {
  const length = typeof value === "string" ? value.length : JSON.stringify(value)?.length;
  return length ? `[${label} omitted: ${length} chars]` : `[${label} omitted]`;
}

function redactInlineDataUris(value: string): string {
  return value.replace(
    INLINE_DATA_URI_PATTERN,
    (_match, prefix: string, uri: string) => `${prefix}[inline data URI: ${uri.length} chars]`,
  );
}

function redactStructuredTextValue(value: string): string {
  const host = getAiTransportHost();
  const redacted = host.redactToolPayloadText(value);
  const trimmed = redacted.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return redacted;
  }
  try {
    const redactedWrapper = host.redactSecrets({ structuredTextValue: JSON.parse(redacted) });
    return JSON.stringify(redactedWrapper.structuredTextValue);
  } catch {
    return redacted;
  }
}

function stringifyStructuredBlock(block: Record<string, unknown>): string | undefined {
  const seen = new WeakSet<object>();
  try {
    const redactedWrapper = getAiTransportHost().redactSecrets({ structuredToolResult: block });
    const redactedBlock = redactedWrapper.structuredToolResult;
    const serialized = JSON.stringify(
      redactedBlock,
      function structuredToolResultReplacer(this: unknown, key, value) {
        if (OPAQUE_OR_BINARY_FIELD_RE.test(key)) {
          return `[omitted ${key}]`;
        }
        if (key === "data") {
          const mimeType = readMimeType(this);
          if (mimeType && isBinaryMimeType(mimeType)) {
            return describeOmittedValue(value, "binary data");
          }
        }
        if (typeof value === "bigint") {
          return value.toString();
        }
        if (typeof value === "string") {
          return redactInlineDataUris(redactStructuredTextValue(value));
        }
        if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
          return undefined;
        }
        if (!value || typeof value !== "object") {
          return value;
        }
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
        return value;
      },
    );
    if (!serialized || serialized === "{}") {
      return undefined;
    }
    return serialized;
  } catch {
    return undefined;
  }
}

function truncateProviderToolText(text: string): string {
  if (text.length <= PROVIDER_TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, PROVIDER_TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}

export function describeToolResultMediaPlaceholder(blocks: readonly unknown[]): string | undefined {
  let hasImage = false;
  let hasAudio = false;

  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    // A text block's own mime metadata describes its content (e.g. SVG source),
    // not attached media; skip it to avoid false image detection.
    const mimeType = type === "text" ? undefined : readMimeType(record)?.toLowerCase();
    const looksImage =
      (type ? IMAGE_TOOL_RESULT_TYPES.has(type) : false) || mimeType?.startsWith("image/") === true;
    const looksAudio =
      (type ? AUDIO_TOOL_RESULT_TYPES.has(type) : false) || mimeType?.startsWith("audio/") === true;
    if (!looksImage && !looksAudio) {
      continue;
    }
    // A media-shaped block with no payload is a malformed husk, not attached
    // media; advertising it would point the model at media that was never sent.
    if (!hasMediaPayload(record)) {
      continue;
    }
    hasImage ||= looksImage;
    hasAudio ||= looksAudio;
  }

  if (hasImage && hasAudio) {
    return "(see attached media)";
  }
  if (hasAudio) {
    return "(see attached audio)";
  }
  if (hasImage) {
    return "(see attached image)";
  }
  return undefined;
}

export function extractToolResultBlockText(block: unknown): string | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const record = block as Record<string, unknown>;
  if (typeof record.type === "string" && MEDIA_ONLY_TOOL_RESULT_TYPES.has(record.type)) {
    if (hasMediaPayload(record)) {
      // Genuine media replays through provider media paths, not as text.
      return undefined;
    }
    // A media-labeled husk with no payload has nothing to render on the media
    // path. Surface a fixed placeholder: dropping the block would make the tool
    // output vanish for the model, and JSON-stringifying it can leak nested
    // payload-shaped fields into provider text.
    return AUDIO_TOOL_RESULT_TYPES.has(record.type)
      ? MISSING_AUDIO_PAYLOAD_TEXT
      : MISSING_IMAGE_PAYLOAD_TEXT;
  }
  if (record.type === "text") {
    const text = typeof record.text === "string" ? record.text : "";
    return text ? sanitizeSurrogates(text) : undefined;
  }
  const structured = stringifyStructuredBlock(record);
  return structured ? sanitizeSurrogates(truncateProviderToolText(structured)) : undefined;
}

export function extractToolResultText(blocks: readonly unknown[]): string {
  const explicitTexts: string[] = [];
  const structuredTexts: string[] = [];
  for (const block of blocks) {
    const text = extractToolResultBlockText(block);
    if (!text) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text") {
      explicitTexts.push(text);
    } else {
      structuredTexts.push(text);
    }
  }
  if (explicitTexts.length > 0) {
    return sanitizeSurrogates(explicitTexts.join("\n"));
  }
  return sanitizeSurrogates(truncateProviderToolText(structuredTexts.join("\n")));
}
