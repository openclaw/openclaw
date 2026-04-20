import { createHash } from "node:crypto";

// Whitespace + lowercase + strip non-word punctuation. Stable, no language
// awareness — Jaccard dedupe over the result has to tolerate paraphrase
// variation, not equate semantically distinct sentences.
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): Set<string> {
  const normalized = normalizeForMatch(text);
  if (normalized.length === 0) {
    return new Set();
  }
  const out = new Set<string>();
  for (const tok of normalized.split(" ")) {
    if (tok.length > 0) {
      out.add(tok);
    }
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const tok of small) {
    if (large.has(tok)) {
      intersection++;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function contentHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}
