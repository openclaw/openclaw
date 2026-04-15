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
    normalizeLocationPath(ref.path),
    String(ref.startLine | 0),
    String(ref.endLine | 0),
    ref.contentHash,
  ].join("\u0000");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// Hash-free location key. Derivable from any MemorySearchResult (which does
// not carry a content hash). Used by future rerank / shadow-touch joins to
// look up sidecar rows from a search hit.
export function memoryLocationId(params: {
  source: MemorySource;
  path: string;
  startLine: number;
  endLine: number;
}): string {
  const canonical = [
    params.source,
    normalizeLocationPath(params.path),
    String(params.startLine | 0),
    String(params.endLine | 0),
  ].join("\u0000");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// Conservative path normalization so backend casing/separator drift does not
// fragment the location-id space. Intentionally narrow: POSIX separator,
// strip leading "./", collapse repeated "/" — no case folding (paths are
// case-sensitive on Linux/macOS and we must not silently merge distinct
// files).
export function normalizeLocationPath(path: string): string {
  let p = path.replace(/\\/g, "/");
  p = p.replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  return p;
}
