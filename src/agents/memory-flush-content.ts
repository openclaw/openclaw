const DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS = 800;

/** Reject oversized daily appends and replayed notes without rewriting either input. */
export function assertNewMemoryFlushContent(
  existing: string,
  content: string,
  relativePath: string,
): void {
  if (
    /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(relativePath) &&
    content.length > DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS
  ) {
    throw new Error(
      `Memory flush append rejected: content too large (${content.length} chars; max ${DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS}). Nothing was appended. Retry with a short pointer only.`,
    );
  }
  const previous = existing.replaceAll("\r\n", "\n").trim();
  if (!previous) {
    return;
  }
  const proposed = content.replaceAll("\r\n", "\n").trim();
  const proposedBlocks = new Set(proposed.split(/\n[\t ]*\n+/));
  // A read window can omit the file's prefix. Compare complete paragraphs too,
  // but allow a reused heading when the facts beneath it are new.
  const repeatsBlock = [previous, ...previous.split(/\n[\t ]*\n+/)].some(
    (block) =>
      /[\p{L}\p{N}]/u.test(block) &&
      !/^#{1,6}[\t ]+[^\n]+$/.test(block) &&
      (proposedBlocks.has(block) || proposed.startsWith(`${block}\n`)),
  );
  if (repeatsBlock) {
    throw new Error(
      "Memory flush content repeats saved note text. Nothing was appended. Retry with only new content; do not include existing entries or a complete rewritten note.",
    );
  }
}
