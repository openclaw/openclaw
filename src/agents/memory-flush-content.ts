/** Reject replayed notes without editing either the saved bytes or the proposed delta. */
export function assertNewMemoryFlushContent(existing: string, content: string): void {
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
