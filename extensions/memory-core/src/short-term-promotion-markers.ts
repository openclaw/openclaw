export function buildPromotionMarker(candidateKey: string): string {
  return `<!-- openclaw-memory-promotion:${candidateKey} -->`;
}

export function extractPromotionKeys(content: string): string[] {
  // Source paths can contain spaces; the comment boundary terminates a key.
  return [...content.matchAll(/<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->/giu)]
    .map((match) => match[1]?.trim())
    .filter((key): key is string => Boolean(key));
}
