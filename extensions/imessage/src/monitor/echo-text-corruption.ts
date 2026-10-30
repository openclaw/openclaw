// Both echo caches must match attributedBody corruption against the clean outbound text.

function isLeadingEchoTextCorruptionMarker(code: number): boolean {
  return (
    code === 0x0000 || code === 0xfeff || code === 0xfffd || code === 0xfffe || code === 0xffff
  );
}

export function normalizeIMessageEchoText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  let offset = 0;
  while (
    offset < normalized.length &&
    isLeadingEchoTextCorruptionMarker(normalized.charCodeAt(offset))
  ) {
    offset += 1;
  }
  return normalized.slice(offset).trim() || undefined;
}
