export function isTextContentBlock(block: unknown): block is { type: "text"; text: string } {
  if (!block || typeof block !== "object") {
    return false;
  }
  const rec = block as { type?: unknown; text?: unknown };
  return rec.type === "text" && typeof rec.text === "string";
}

export function collectTextContentBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(isTextContentBlock).map((block) => block.text);
}
