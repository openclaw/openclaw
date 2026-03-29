export type AdfTextNode = {
  type: "text";
  text: string;
};

export type AdfParagraphNode = {
  type: "paragraph";
  content: AdfTextNode[];
};

export type AdfDocument = {
  type: "doc";
  version: 1;
  content: AdfParagraphNode[];
};

export function toMinimalAdfTextDocument(text: string): AdfDocument {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    throw new Error("ADF text content must not be empty.");
  }

  const paragraphs = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      type: "paragraph" as const,
      content: [{ type: "text" as const, text: line }],
    }));

  if (paragraphs.length === 0) {
    throw new Error("ADF text content must include at least one paragraph.");
  }

  return {
    type: "doc",
    version: 1,
    content: paragraphs,
  };
}

