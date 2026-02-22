/**
 * Semantic chunking preserving section boundaries.
 * Splits markdown on headers (##, ###) and keeps chunks within size limits.
 */

export type Chunk = {
  text: string;
  section?: string;
};

export function chunkMarkdown(
  markdown: string,
  options: { maxChars?: number; overlap?: number },
): Chunk[] {
  const maxChars = options.maxChars ?? 800;
  const overlap = options.overlap ?? 100;

  const sections = markdown.split(/(?=^#{1,6}\s+)/m).filter(Boolean);
  const chunks: Chunk[] = [];
  let currentSection = "";

  for (const section of sections) {
    const headerMatch = section.match(/^(#{1,6})\s+(.+?)(?:\n|$)/);
    if (headerMatch) {
      currentSection = headerMatch[2].trim();
    }
    let rest = section;
    while (rest.length > maxChars) {
      const splitAt = rest.lastIndexOf("\n\n", maxChars);
      const cut = splitAt > maxChars * 0.5 ? splitAt + 2 : maxChars;
      const piece = rest.slice(0, cut).trim();
      if (piece) {
        chunks.push({ text: piece, section: currentSection || undefined });
      }
      rest = rest.slice(Math.max(0, cut - overlap));
    }
    const trimmed = rest.trim();
    if (trimmed) {
      chunks.push({ text: trimmed, section: currentSection || undefined });
    }
  }
  return chunks;
}
