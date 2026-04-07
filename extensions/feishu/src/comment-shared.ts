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
  const type = readString(element.type)?.trim();
  if (type === "text_run" && isRecord(element.text_run)) {
    return (
      readString(element.text_run.content)?.trim() ||
      readString(element.text_run.text)?.trim() ||
      undefined
    );
  }
  if (type === "mention") {
    const mention = isRecord(element.mention) ? element.mention : undefined;
    const mentionName =
      readString(mention?.name)?.trim() ||
      readString(mention?.display_name)?.trim() ||
      readString(element.name)?.trim();
    return mentionName ? `@${mentionName}` : "@mention";
  }
  if (type === "docs_link") {
    const docsLink = isRecord(element.docs_link) ? element.docs_link : undefined;
    return (
      readString(docsLink?.text)?.trim() ||
      readString(docsLink?.url)?.trim() ||
      readString(element.text)?.trim() ||
      readString(element.url)?.trim() ||
      undefined
    );
  }
  return (
    readString(element.text)?.trim() ||
    readString(element.content)?.trim() ||
    readString(element.name)?.trim() ||
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
