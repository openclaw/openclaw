import {
  asOptionalRecord,
  hasNonEmptyString as sharedHasNonEmptyString,
  isRecord as sharedIsRecord,
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/text-runtime";

export function encodeQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const trimmed = value?.trim();
    if (trimmed) {
      query.set(key, trimmed);
    }
  }
  const queryString = query.toString();
  return queryString ? `?${queryString}` : "";
}

export const readString = readStringValue;

export const normalizeString = normalizeOptionalString;

export const isRecord = sharedIsRecord;

export const asRecord = asOptionalRecord;

export const hasNonEmptyString = sharedHasNonEmptyString;

export function extractCommentElementText(element: unknown): string | undefined {
  if (!isRecord(element)) {
    return undefined;
  }
  const type = normalizeString(element.type);
  if (type === "text_run" && isRecord(element.text_run)) {
    return normalizeString(element.text_run.content) || normalizeString(element.text_run.text);
  }
  if (type === "mention") {
    const mention = isRecord(element.mention) ? element.mention : undefined;
    const mentionName =
      normalizeString(mention?.name) ||
      normalizeString(mention?.display_name) ||
      normalizeString(element.name);
    return mentionName ? `@${mentionName}` : "@mention";
  }
  if (type === "docs_link") {
    const docsLink = isRecord(element.docs_link) ? element.docs_link : undefined;
    return (
      normalizeString(docsLink?.text) ||
      normalizeString(docsLink?.url) ||
      normalizeString(element.text) ||
      normalizeString(element.url) ||
      undefined
    );
  }
  return (
    normalizeString(element.text) ||
    normalizeString(element.content) ||
    normalizeString(element.name) ||
    undefined
  );
}

export function extractReplyText(
  reply: { content?: { elements?: unknown[] } } | undefined,
): string | undefined {
  if (!reply || !isRecord(reply.content)) {
    return undefined;
  }
  const elements = Array.isArray(reply.content.elements) ? reply.content.elements : [];
  const text = elements
    .map(extractCommentElementText)
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("")
    .trim();
  return text || undefined;
}
