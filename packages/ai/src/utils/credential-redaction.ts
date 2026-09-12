import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import {
  expectDefined,
  extractBalancedJsonFragments,
  stableStringify,
} from "@openclaw/normalization-core";
import { parseRetryAfterHeadersSeconds } from "../internal/retry-after.js";

const NON_CREDENTIAL_FIELD_NAMES = new Set([
  "passwordfile",
  "tokenbudget",
  "tokencount",
  "tokenfield",
  "tokenlimit",
  "tokens",
]);
const CREDENTIAL_FIELD_SUFFIX_RE =
  /(?:apikey|cookie|credential|passphrase|passwd|password|privatekey|secret|secret(?:access)?key|signingkey|token)$/u;
const MEDIA_PAYLOAD_SUFFIXES =
  "base64|blob|buffer|bytes|data|delta|frames?|output|result|(?:file|media|source)?(?:uri|url)";
const MEDIA_FIELD_NAME_RE = new RegExp(
  `^(?:input|output)?(?:audio|image|video)s?(?:${MEDIA_PAYLOAD_SUFFIXES})*$`,
  "u",
);
const MEDIA_PAYLOAD_SUFFIX_RE = new RegExp(`^(?:${MEDIA_PAYLOAD_SUFFIXES})$`, "u");
const MEDIA_WRAPPER_NAME_RE = /^(?:input_|output_)?(?:audio|image|video)s?(?:_|$)/iu;
const DIAGNOSTIC_FIELD_SEPARATOR_RE = /[^a-z0-9]/g;
const MEDIA_TYPE_RE = /^(?:input|output)?(?:audio|image|video)/u;
const MEDIA_MIME_RE = /^(?:audio|image|video)\//iu;
const MEDIA_ARRAY_INDEX_RE = /^(?:0|[1-9]\d*)$/u;
const MEDIA_URL_SUFFIX_RE = /(?:uri|url)$/u;
const MEDIA_MIME_FIELDS = [
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
  "contentType",
  "content_type",
];
const AUTHORIZATION_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}/giu;
const JWT_VALUE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
const COOKIE_HEADER_RE = /\b((?:set-)?cookie\s*:\s*)([^\r\n]+)/giu;
const QUOTED_CREDENTIAL_HEADER_RE =
  /(["'])((?:[A-Za-z][A-Za-z0-9_.-]*[_.-])?(?:api[_.-]?key|authorization|passphrase|passwd|password|private[_.-]?key|secret(?:[_.-]?access)?[_.-]?key|signing[_.-]?key|token))\1\s*:\s*([^,}\r\n]+)/giu;
const CREDENTIAL_HEADER_RE =
  /\b((?:[A-Za-z][A-Za-z0-9_.-]*[_.-])?(?:api[_.-]?key|authorization|passphrase|passwd|password|private[_.-]?key|secret(?:[_.-]?access)?[_.-]?key|signing[_.-]?key|token))\s*:\s*([^\r\n]+)/giu;
const LOOSE_QUOTED_CREDENTIAL_PAIR_RE =
  /\b((?!(?:api|endpoint|method|model|provider|status|type)=)[A-Za-z][A-Za-z0-9_.-]{0,64})=(["'])([A-Za-z0-9+/._~%=-]{16,})\2/giu;
const LOOSE_CREDENTIAL_PAIR_RE =
  /\b((?!(?:api|endpoint|method|model|provider|status|type)=)[A-Za-z][A-Za-z0-9_.-]{0,64})=([A-Za-z0-9+/._~%=-]{16,})(?=[;&#'"\s]|$)/giu;
const MEDIA_DATA_URL_RE =
  /data:(?:audio|image|video)\/[a-z0-9.+-]+(?:;[^,;\s]+)*;base64,[ \t]*(?:\r?\n[ \t]*)?[a-z0-9+/_=-]+(?:[ \t]*\r?\n[ \t]*[a-z0-9+/_=-]+)*/giu;
const MAX_DIAGNOSTIC_JSON_LENGTH = 16 * 1024;
const BRACKET_PROSE_PATTERN = String.raw`(\[+)([A-Za-z][A-Za-z0-9 _.-]*|\s*\d+\s+(?!(?:true|false|null)(?![\w-]))[A-Za-z][A-Za-z0-9 _.=-]*)(\]+)`;
const BRACKET_PROSE_RE = new RegExp(`^${BRACKET_PROSE_PATTERN}$`, "u");
const BRACKET_PROSE_PART_RE = new RegExp(String.raw`(?<!\[)${BRACKET_PROSE_PATTERN}`, "gu");
const JSON_LITERAL_PROSE_START_RE = /^(?:true|false|null)\b(?!-)/u;
const PROSE_ASSIGNMENT_RE =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)\s*(?:=\s*)+(?=([^=;&\s\]'"},]+))/gu;
const PRIVATE_KEY_HEADER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY/iu;
const JSON_ARRAY_START_RE = /\[\s*(?:[{"\d\]-]|true\b|false\b|null\b)/u;
const MALFORMED_JSON_RE =
  /\{|(?:"[^"]+"|\b(?:b64_json|data|(?:input|output)?(?:audio|image|video)[\w-]*))\s*:/iu;

function looksLikeDiagnosticJson(value: string): boolean {
  return JSON_ARRAY_START_RE.test(value) || MALFORMED_JSON_RE.test(value);
}

function isPlainBracketProse(value: string): boolean {
  const match = BRACKET_PROSE_RE.exec(value);
  return (
    match !== null &&
    expectDefined(match[1], "opening brackets").length ===
      expectDefined(match[3], "closing brackets").length &&
    !JSON_LITERAL_PROSE_START_RE.test(expectDefined(match[2], "bracket prose"))
  );
}

function hasSensitiveProseContent(value: string): boolean {
  if (PRIVATE_KEY_HEADER_RE.test(value)) {
    return true;
  }
  let mediaContext = false;
  let contextualPayload = false;
  for (const match of value.matchAll(PROSE_ASSIGNMENT_RE)) {
    const assigned = expectDefined(match[2], "diagnostic assignment value");
    const valueEnd = match.index + match[0].length + assigned.length;
    if (assigned === "<redacted>" && value[valueEnd] !== "=") {
      continue;
    }
    const key = expectDefined(match[1], "diagnostic assignment field");
    const normalized = normalizeDiagnosticFieldName(key);
    if (
      isCredentialFieldName(normalized) ||
      extractDiagnosticMediaField(key, normalized, undefined, false)
    ) {
      return true;
    }
    mediaContext ||= isDiagnosticMediaPayload({ [key]: { value: assigned } });
    contextualPayload ||= Boolean(extractDiagnosticMediaField(key, normalized, undefined, true));
    if (mediaContext && contextualPayload) {
      return true;
    }
  }
  return false;
}

function normalizeDiagnosticFieldName(value: string): string {
  return value.toLowerCase().replaceAll(DIAGNOSTIC_FIELD_SEPARATOR_RE, "");
}

function isCredentialFieldName(normalized: string): boolean {
  if (!normalized || NON_CREDENTIAL_FIELD_NAMES.has(normalized)) {
    return false;
  }
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    CREDENTIAL_FIELD_SUFFIX_RE.test(normalized)
  );
}

function redactCredentialText(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE_RE, "$1 <redacted>")
    .replace(JWT_VALUE_RE, "<redacted-jwt>")
    .replace(COOKIE_HEADER_RE, "$1<redacted>")
    .replace(QUOTED_CREDENTIAL_HEADER_RE, "$1$2$1: <redacted>")
    .replace(CREDENTIAL_HEADER_RE, "$1: <redacted>")
    .replace(LOOSE_QUOTED_CREDENTIAL_PAIR_RE, "$1=$2<redacted>$2")
    .replace(LOOSE_CREDENTIAL_PAIR_RE, "$1=<redacted>");
}

function diagnosticBytes(value: unknown, numericArrays = false): Uint8Array | undefined {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : numericArrays &&
          Array.isArray(value) &&
          value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        ? Uint8Array.from(value)
        : undefined;
}

function isDiagnosticMediaPayload(descriptors: PropertyDescriptorMap): boolean {
  const type = descriptors.type?.value;
  if (typeof type === "string" && MEDIA_TYPE_RE.test(normalizeDiagnosticFieldName(type))) {
    return true;
  }
  for (const key of MEDIA_MIME_FIELDS) {
    const mime = descriptors[key]?.value;
    if (typeof mime === "string" && MEDIA_MIME_RE.test(mime)) {
      return true;
    }
  }
  return false;
}

type DiagnosticMediaField =
  | { kind: "context" }
  | {
      kind: "redacted";
      bytes?: number;
      source?: string | Uint8Array;
    };
export type DiagnosticProjectionPolicy = {
  omitField?: (key: string) => boolean;
  propertyScope?: "enumerable" | "error";
  projectBinary?: (binary: Uint8Array) => unknown;
  projectMedia?: (
    key: string,
    media: Extract<DiagnosticMediaField, { kind: "redacted" }>,
  ) => Record<string, unknown>;
};

function extractDiagnosticMediaField(
  key: string,
  normalized: string,
  value: unknown,
  parentMedia: boolean,
): DiagnosticMediaField | undefined {
  const privateField = normalized === "b64json";
  const mediaField = MEDIA_FIELD_NAME_RE.test(normalized) || MEDIA_WRAPPER_NAME_RE.test(key);
  const contextualPayload = parentMedia && MEDIA_PAYLOAD_SUFFIX_RE.test(normalized);
  if (!privateField && !mediaField && !contextualPayload) {
    return parentMedia &&
      value !== null &&
      (typeof value === "object" || MEDIA_ARRAY_INDEX_RE.test(key))
      ? { kind: "context" }
      : undefined;
  }
  if (MEDIA_URL_SUFFIX_RE.test(normalized)) {
    return { kind: "redacted" };
  }
  const encoded = diagnosticBytes(value, true) ?? (typeof value === "string" ? value : undefined);
  if (encoded === undefined) {
    return { kind: privateField || Array.isArray(value) ? "redacted" : "context" };
  }
  const bytes =
    typeof encoded === "string" ? estimateBase64DecodedBytes(encoded) : encoded.byteLength;
  return { kind: "redacted", bytes, source: encoded };
}

export function projectDiagnosticValue(
  value: unknown,
  policy: DiagnosticProjectionPolicy = {},
  seen = new WeakSet<object>(),
  mediaPayload = false,
  state = { changed: false, nodesRemaining: 64 },
): unknown {
  try {
    if (typeof value === "string") {
      const projected = redactDiagnosticText(value);
      state.changed ||= projected !== value;
      return projected;
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const binary = diagnosticBytes(value);
    if (binary) {
      state.changed = true;
      return (
        policy.projectBinary?.(binary) ?? {
          redacted: "<redacted>",
          bytes: binary.byteLength,
        }
      );
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    if (state.nodesRemaining-- <= 0) {
      state.changed = true;
      return "[Truncated]";
    }
    try {
      // Brand-check without provider getters; retain only numeric retry timing.
      Headers.prototype.has.call(value, "retry-after");
      const seconds = parseRetryAfterHeadersSeconds(value);
      state.changed = true;
      return seconds === undefined ? {} : { "retry-after-ms": seconds * 1000 };
    } catch {
      // Other objects follow the bounded descriptor walk below.
    }
    const keys = Reflect.ownKeys(value);
    // Snapshot descriptors before recursion; the map restores numeric key order from proxies.
    const descriptors: PropertyDescriptorMap = Object.create(null);
    for (let index = 0; index < Math.min(keys.length, 64); index += 1) {
      const key = keys[index];
      if (typeof key !== "string") {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor) {
        descriptors[key] = descriptor;
      }
    }
    state.changed ||= keys.length > 64;
    seen.add(value);
    const out = (Array.isArray(value) ? [] : {}) as Record<string, unknown>;
    const rawName =
      typeof descriptors.name?.value === "string" ? descriptors.name.value : descriptors.key?.value;
    const redactValueField =
      keys.length > 64 ||
      (typeof rawName === "string" && isCredentialFieldName(normalizeDiagnosticFieldName(rawName)));
    const redactMedia = mediaPayload || keys.length > 64 || isDiagnosticMediaPayload(descriptors);
    for (const key in descriptors) {
      const descriptor = expectDefined(descriptors[key], "diagnostic descriptor");
      if (
        !("value" in descriptor) ||
        (!descriptor.enumerable &&
          (policy.propertyScope === "enumerable" ||
            !["cause", "errors", "message", "name", "stack"].includes(key))) ||
        key === "length"
      ) {
        continue;
      }
      const child = descriptor.value;
      const normalized = policy.omitField?.(key) ? undefined : normalizeDiagnosticFieldName(key);
      if (normalized === undefined || isCredentialFieldName(normalized)) {
        state.changed = true;
        continue;
      }
      if (redactValueField && key === "value") {
        out[key] = "<redacted>";
        state.changed = true;
        continue;
      }
      const media = extractDiagnosticMediaField(key, normalized, child, redactMedia);
      if (media?.kind === "redacted") {
        const redacted =
          media.bytes === undefined ? "<redacted>" : { redacted: "<redacted>", bytes: media.bytes };
        Object.assign(out, policy.projectMedia?.(key, media) ?? { [key]: redacted });
        state.changed = true;
        continue;
      }
      const childMedia = media?.kind === "context";
      out[key] = projectDiagnosticValue(child, policy, seen, childMedia, state);
    }
    return out;
  } catch {
    state.changed = true;
    return "[Unserializable]";
  }
}

/** Redacts bounded structured JSON while preserving harmless diagnostic text byte-for-byte. */
export function redactDiagnosticText(value: string): string {
  const text = redactCredentialText(value).replace(MEDIA_DATA_URL_RE, "<redacted>");
  if (!looksLikeDiagnosticJson(text)) {
    return text;
  }
  const allowProse = !hasSensitiveProseContent(text);
  if (text.length > MAX_DIAGNOSTIC_JSON_LENGTH) {
    // Prove the whole bracket surface is prose before bypassing the structured-data bound.
    const remaining =
      allowProse && !MALFORMED_JSON_RE.test(text)
        ? text.replace(BRACKET_PROSE_PART_RE, (part) => (isPlainBracketProse(part) ? "" : part))
        : text;
    if (allowProse && !/[[\]{}]/u.test(remaining) && !MALFORMED_JSON_RE.test(text)) {
      return text;
    }
    return "[Oversized diagnostic JSON redacted]";
  }
  let cursor = 0;
  let redacted = "";
  let unstructured = "";
  for (const fragment of extractBalancedJsonFragments(text)) {
    const plainText = text.slice(cursor, fragment.startIndex);
    unstructured += plainText;
    redacted += plainText;
    // Only the complete outer fragment can establish a prose exemption.
    if (allowProse && isPlainBracketProse(fragment.json)) {
      redacted += fragment.json;
      cursor = fragment.endIndex + 1;
      continue;
    }
    try {
      const state = { changed: false, nodesRemaining: 64 };
      const parsed = JSON.parse(fragment.json);
      const projected = projectDiagnosticValue(parsed, {}, new WeakSet(), false, state);
      redacted += state.changed ? stableStringify(projected) : fragment.json;
    } catch {
      return "[Malformed diagnostic JSON redacted]";
    }
    cursor = fragment.endIndex + 1;
  }
  const remainder = text.slice(cursor);
  return looksLikeDiagnosticJson(unstructured + remainder)
    ? "[Malformed diagnostic JSON redacted]"
    : redacted + remainder;
}
