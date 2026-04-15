import { createHash } from "node:crypto";

export type MemorySource = "memory" | "sessions";

export type MemoryRef = {
  source: MemorySource;
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
};

// Deterministic, backend-agnostic id for a memory chunk.
// Stable across builtin (SQLite chunks row) and qmd (subprocess result),
// because all four inputs are present on MemorySearchResult in both paths.
export function memoryRefId(ref: MemoryRef): string {
  const canonical = [
    ref.source,
    ref.path,
    String(ref.startLine | 0),
    String(ref.endLine | 0),
    ref.contentHash,
  ].join("\u0000");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
