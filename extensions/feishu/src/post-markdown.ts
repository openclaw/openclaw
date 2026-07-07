// Feishu post message markdown normalization.

/**
 * Feishu's `post` + `tag: md` rendering treats a single `\n` as a space.
 * Upgrade single newlines outside fenced code blocks to paragraph breaks (`\n\n`)
 * so paragraphs and line breaks are preserved instead of being mashed together.
 * Existing blank lines and code-block internals are left untouched.
 */
export function normalizeFeishuPostMarkdownNewlines(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    result.push(line);
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
    }
    if (i < lines.length - 1 && !inCodeBlock && line !== "" && lines[i + 1] !== "") {
      result.push("");
    }
  }
  return result.join("\n");
}
