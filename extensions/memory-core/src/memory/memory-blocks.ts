export type MemoryBlock = {
  startLine: number;
  endLine: number;
  lineNumbers: number[];
  text: string;
};

export const MEMORY_BLOCK_SEPARATOR = "----";
export const ESCAPED_MEMORY_BLOCK_SEPARATOR = "---";

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function isMemoryBlockSeparator(line: string): boolean {
  return line.trim() === MEMORY_BLOCK_SEPARATOR;
}

function trimLineEntries(entries: Array<{ line: string; lineNumber: number }>): Array<{
  line: string;
  lineNumber: number;
}> {
  let start = 0;
  let end = entries.length;
  while (start < end && entries[start]?.line.trim() === "") {
    start += 1;
  }
  while (end > start && entries[end - 1]?.line.trim() === "") {
    end -= 1;
  }
  return entries.slice(start, end);
}

function appendMemoryBlock(
  blocks: MemoryBlock[],
  entries: Array<{ line: string; lineNumber: number }>,
): void {
  const trimmed = trimLineEntries(entries);
  if (trimmed.length === 0) {
    return;
  }
  blocks.push({
    startLine: trimmed[0]?.lineNumber ?? 1,
    endLine: trimmed[trimmed.length - 1]?.lineNumber ?? 1,
    lineNumbers: trimmed.map((entry) => entry.lineNumber),
    text: trimmed.map((entry) => entry.line).join("\n"),
  });
}

export function normalizeMemoryBlockText(input: string): string {
  const normalized = normalizeLineEndings(input).trim();
  return normalized
    .split("\n")
    .map((line) => (isMemoryBlockSeparator(line) ? ESCAPED_MEMORY_BLOCK_SEPARATOR : line))
    .join("\n")
    .trim();
}

export function formatMemoryBlock(input: string): string {
  const text = normalizeMemoryBlockText(input);
  return `${text}\n\n${MEMORY_BLOCK_SEPARATOR}\n`;
}

export function parseMemoryBlocks(content: string): MemoryBlock[] {
  const lines = normalizeLineEndings(content).split("\n");
  const blocks: MemoryBlock[] = [];
  let entries: Array<{ line: string; lineNumber: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isMemoryBlockSeparator(line)) {
      appendMemoryBlock(blocks, entries);
      entries = [];
      continue;
    }
    entries.push({ line, lineNumber: index + 1 });
  }

  appendMemoryBlock(blocks, entries);
  return blocks;
}
