export function detectLineEnding(content: string): "\r\n" | "\n" {
  const lfIdx = content.indexOf("\n");
  return lfIdx > 0 && content[lfIdx - 1] === "\r" ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeNewFileLineEndings(filePath: string, content: string): string {
  // CMD can misparse labels in LF-only batch files, regardless of the writer's OS.
  return /\.(?:cmd|bat)$/i.test(filePath) ? normalizeToLF(content).replace(/\n/g, "\r\n") : content;
}

export function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}
