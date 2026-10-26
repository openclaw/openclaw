export type ExtractedFrontmatterBlock = {
  block: string;
  body: string;
  lineRange: { startLine: 1; endLine: number };
};

export function normalizeFrontmatterContent(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

const FRONTMATTER_CLOSING_DELIMITER = /(?:^|\n)---[^\S\n]*(?:\n|(?![\s\S]))/;
const FRONTMATTER_OPENING_DELIMITER = /^---[^\S\n]*\n/;

export function extractFrontmatterBlockFromNormalized(
  normalized: string,
): ExtractedFrontmatterBlock | undefined {
  const opening = FRONTMATTER_OPENING_DELIMITER.exec(normalized);
  if (!opening) {
    return undefined;
  }
  const blockStart = opening[0].length;
  const tail = normalized.slice(blockStart);
  const closing = FRONTMATTER_CLOSING_DELIMITER.exec(tail);
  if (!closing) {
    return undefined;
  }
  const bodyStart = blockStart + closing.index + closing[0].length;
  const prefix = normalized.slice(0, bodyStart);
  return {
    block: tail.slice(0, closing.index),
    body: normalized.slice(bodyStart),
    lineRange: {
      startLine: 1,
      endLine: prefix.split("\n").length - (prefix.endsWith("\n") ? 1 : 0),
    },
  };
}

/** Splits a complete leading YAML frontmatter block from its Markdown body. */
export function extractFrontmatterBlock(content: string): ExtractedFrontmatterBlock | undefined {
  const normalized = normalizeFrontmatterContent(content);
  return extractFrontmatterBlockFromNormalized(normalized);
}

export function hasFrontmatterOpeningDelimiter(content: string): boolean {
  return FRONTMATTER_OPENING_DELIMITER.test(content);
}
