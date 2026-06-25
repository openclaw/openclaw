/** Collects text block payloads from provider-style structured content arrays.
 *  Recognises "text", "input_text" (OpenAI Responses API), and "output_text". */
export function collectTextContentBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (
      (rec.type === "text" || rec.type === "input_text" || rec.type === "output_text") &&
      typeof rec.text === "string"
    ) {
      parts.push(rec.text);
    }
  }
  return parts;
}
