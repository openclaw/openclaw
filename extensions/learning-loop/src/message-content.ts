const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);

function readTextValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    value &&
    typeof value === "object" &&
    typeof (value as { value?: unknown }).value === "string"
  ) {
    return (value as { value: string }).value;
  }

  return "";
}

function extractTextBlock(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const type = (block as { type?: unknown }).type;
  if (typeof type !== "string" || !TEXT_BLOCK_TYPES.has(type)) {
    return "";
  }

  return readTextValue((block as { text?: unknown }).text);
}

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  const directText = extractTextBlock(content);
  if (directText) {
    return directText;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => extractTextBlock(block))
      .filter(Boolean)
      .join("\n");
  }

  return "";
}
