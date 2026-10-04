export function isTextContentBlock(block: unknown): block is { type: "text"; text: string } {
  if (!block || typeof block !== "object") {
    return false;
  }
  const rec = block as { type?: unknown; text?: unknown };
  return rec.type === "text" && typeof rec.text === "string";
}

/** Collects text block payloads from provider-style structured content arrays. */
export function collectTextContentBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const block of content) {
    if (isTextContentBlock(block)) {
      parts.push(block.text);
    }
  }
  return parts;
}
