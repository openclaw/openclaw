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

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

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
