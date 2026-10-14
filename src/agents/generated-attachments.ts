import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { ReplyMediaAttachment } from "../shared/reply-payload.types.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

export type AgentGeneratedAttachment = Omit<ReplyMediaAttachment, "trustedLocalMedia">;

function generatedAttachmentReference(attachment: AgentGeneratedAttachment): string | undefined {
  return normalizeOptionalString(
    attachment.path ?? attachment.url ?? attachment.mediaUrl ?? attachment.filePath,
  );
}

/** Return unique media URLs/paths from generated attachments. */
export function mediaUrlsFromGeneratedAttachments(
  attachments: readonly AgentGeneratedAttachment[] | undefined,
): string[] {
  return uniqueStrings(
    attachments?.flatMap((attachment) => generatedAttachmentReference(attachment) ?? []) ?? [],
  );
}

function nameFromGeneratedAttachment(attachment: AgentGeneratedAttachment): string | undefined {
  return (
    normalizeOptionalString(attachment.name) ??
    basenameFromAnyPath(generatedAttachmentReference(attachment) ?? "")
  );
}

function neutralizeEscapedGeneratedMediaDirective(value: string): string {
  // Rehydrated provider lines must not forge media or fence away the actual generated attachment.
  return value
    .replace(/((?:\\r\\n|\\n|\\r)[^\S\r\n]*)(media):/giu, "$1$2：")
    .replace(/((?:\\r\\n|\\n|\\r) {0,3})(`{3,}|~{3,})/gu, "$1>$2");
}

const GENERATED_MEDIA_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  "\r": "\\r",
  "\n": "\\n",
  "\t": "\\t",
};
const GENERATED_MEDIA_ESCAPE_PATTERN = new RegExp(
  String.raw`[\\\u0000-\u001f\u007f\u2028\u2029]`,
  "g",
);

/** Escape provider-controlled summary text without changing its structured result. */
export function sanitizeGeneratedMediaDisplayText(value: string): string {
  const sanitized = value.replace(
    GENERATED_MEDIA_ESCAPE_PATTERN,
    (char) =>
      GENERATED_MEDIA_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return neutralizeEscapedGeneratedMediaDirective(sanitizeForPromptLiteral(sanitized))
    .replaceAll("[[", "［[")
    .replaceAll("![", "!［");
}

function quoteGeneratedAttachmentDisplay(value: string): string {
  // Only encode the prompt copy: signed URLs and structured delivery metadata must remain exact.
  return neutralizeEscapedGeneratedMediaDirective(
    JSON.stringify(sanitizeForPromptLiteral(value)),
  ).replaceAll("[", "\\u005b");
}

/** Format generated attachment metadata as prompt-safe text lines. */
export function formatGeneratedAttachmentLines(
  attachments: readonly AgentGeneratedAttachment[] | undefined,
): string[] {
  if (!attachments?.length) {
    return [];
  }
  const lines = ["Attachments:"];
  for (const [index, attachment] of attachments.entries()) {
    const parts = [`${index + 1}.`];
    const type = normalizeOptionalString(attachment.type);
    const name = nameFromGeneratedAttachment(attachment);
    const mimeType = normalizeOptionalString(attachment.mimeType);
    const path = normalizeOptionalString(attachment.path ?? attachment.filePath);
    const url = normalizeOptionalString(attachment.url ?? attachment.mediaUrl);
    if (type) {
      parts.push(`type=${quoteGeneratedAttachmentDisplay(type).slice(1, -1)}`);
    }
    if (name) {
      parts.push(`name=${quoteGeneratedAttachmentDisplay(name)}`);
    }
    if (mimeType) {
      parts.push(`mimeType=${quoteGeneratedAttachmentDisplay(mimeType).slice(1, -1)}`);
    }
    if (path) {
      parts.push(`path=${quoteGeneratedAttachmentDisplay(path)}`);
    } else if (url) {
      parts.push(`mediaUrl=${quoteGeneratedAttachmentDisplay(url)}`);
    }
    lines.push(parts.join(" "));
  }
  return lines;
}
