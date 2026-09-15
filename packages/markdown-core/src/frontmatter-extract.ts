export type FrontmatterLineRange = {
  startLine: 1;
  endLine: number;
};

export type ExtractedFrontmatterBlock = {
  block: string;
  body: string;
  lineRange: FrontmatterLineRange;
};

export function normalizeFrontmatterContent(content: string): string {
  return content
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n");
}

const FRONTMATTER_CLOSING_DELIMITER = /(?:^|\n)---[^\S\n]*(?:\n|(?![\s\S]))/u;
const FRONTMATTER_OPENING_DELIMITER = /^---[^\S\n]*\n/u;

export function hasFrontmatterOpeningDelimiter(content: string): boolean {
  return FRONTMATTER_OPENING_DELIMITER.test(content);
}

/** Splits a complete leading YAML frontmatter block from its Markdown body. */
export function extractFrontmatterBlock(content: string): ExtractedFrontmatterBlock | undefined {
  const normalized = normalizeFrontmatterContent(content);
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
  const frontmatterPrefix = normalized.slice(0, bodyStart);
  const endLine = frontmatterPrefix.split("\n").length - (frontmatterPrefix.endsWith("\n") ? 1 : 0);
  return {
    block: tail.slice(0, closing.index),
    body: normalized.slice(bodyStart),
    lineRange: { startLine: 1, endLine },
  };
}
