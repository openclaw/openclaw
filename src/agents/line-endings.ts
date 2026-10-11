/**
 * Line-ending detection and restoration shared by the file-mutating agent tools.
 */

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const lfIdx = content.indexOf("\n");
  return lfIdx > 0 && content[lfIdx - 1] === "\r" ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
