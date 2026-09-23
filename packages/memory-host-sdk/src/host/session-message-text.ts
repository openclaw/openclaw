/**
 * Flattens persisted transcript message content into the text that session
 * exports index. Transcripts store plain `text` blocks alongside the
 * provider-shaped `input_text` (user) and `output_text` (assistant) blocks.
 */
export function collectRawSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    // SAFETY: parsed JSON block; `type` and `text` stay unknown until narrowed below.
    const record = block as { type?: unknown; text?: unknown };
    if (isSessionTextBlockType(record.type) && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function isSessionTextBlockType(type: unknown): boolean {
  return type === "text" || type === "input_text" || type === "output_text";
}
