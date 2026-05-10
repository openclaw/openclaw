/**
 * Cross-kind utilities. `inferKind` backs the document-level parser in
 * `document.ts`, so callers can parse by filename before using the
 * universal verbs (`resolveOcPath`, `findOcPaths`, `setOcPath`).
 *
 * @module @openclaw/oc-path/dispatch
 */

export type OcKind = "md" | "jsonc" | "jsonl";

/**
 * Recommend a kind from a filename. Pure convention helper — returns
 * the substrate's default mapping. Consumers can override.
 */
export function inferKind(filename: string): OcKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md")) {
    return "md";
  }
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
    return "jsonl";
  }
  if (lower.endsWith(".jsonc") || lower.endsWith(".json")) {
    return "jsonc";
  }
  return null;
}
