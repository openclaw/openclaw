import {
  chunkMarkdown,
  extractCuratedEntryRecallMetadata,
  enforceEmbeddingMaxInputTokens,
  hashText,
  remapChunkLines,
  stripMemoryAnnotationCarriers,
  type MemoryChunk,
  type MemoryEntryProvenance,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import type { EmbeddingProvider } from "./embeddings.js";
import type { IndexedMemoryChunk } from "./manager-chunk-writer.js";
import { chunkSessionContentAtResetBoundary } from "./manager-reset-chunk-boundary.js";
import type { MemoryIndexEntry } from "./manager-sync-base.js";
import type { resolveMemoryPathClassification } from "./memory-path-provenance.js";

export type MemoryIndexPreparationInput = {
  entry: Pick<MemoryIndexEntry, "path" | "mtimeMs" | "lineMap" | "lineProvenance">;
  source: MemorySource;
  content: string;
  pathClassification: Awaited<ReturnType<typeof resolveMemoryPathClassification>>;
  chunking: { tokens: number; overlap: number };
  cutoffLine?: number;
  provider?: Pick<EmbeddingProvider, "id" | "maxInputTokens">;
  hardMaxInputTokens: number;
};

export function prepareMemoryIndexChunks({
  entry,
  source,
  content,
  pathClassification,
  chunking,
  cutoffLine,
  provider,
  hardMaxInputTokens,
}: MemoryIndexPreparationInput): { contentHash: string | undefined; chunks: IndexedMemoryChunk[] } {
  // Hash, chunk, and embed one immutable read; publication validates it again.
  const contentHash = source === "memory" ? hashText(content) : undefined;
  const normalizedEntryPath = entry.path.replaceAll("\\", "/");
  const perEntry =
    source === "memory" &&
    (normalizedEntryPath === "MEMORY.md" || normalizedEntryPath === "USER.md");
  const indexingContent = source === "memory" ? stripMemoryAnnotationCarriers(content) : content;
  // All chunks share one source snapshot; splitting per chunk makes indexing quadratic.
  const sourceLines = source === "memory" ? content.replace(/\r\n/gu, "\n").split("\n") : [];
  const chunkOptions = { ...chunking, perEntry };
  const baseChunks = (
    source === "sessions"
      ? chunkSessionContentAtResetBoundary({
          content: indexingContent,
          cutoffLine,
          lineMap: entry.lineMap,
          chunking: chunkOptions,
        })
      : chunkMarkdown(indexingContent, chunkOptions)
  ).filter((chunk) => chunk.text.trim().length > 0);
  for (const chunk of baseChunks) {
    chunk.provenance = resolveChunkProvenance(entry, source, chunk, pathClassification.originClass);
  }
  // Fragments inherit one entry's metadata; parse each source span once,
  // not once per fragment of a long line or oversized entry.
  const recallMetadata = new Map<string, ReturnType<typeof extractCuratedEntryRecallMetadata>>();
  const chunks = (
    provider !== undefined
      ? enforceEmbeddingMaxInputTokens(provider, baseChunks, hardMaxInputTokens)
      : baseChunks
  ).map((chunk): IndexedMemoryChunk => {
    const start = chunk.entryStartLine ?? chunk.startLine;
    const end = chunk.entryEndLine ?? chunk.endLine;
    const span = `${start}:${end}`;
    let metadata = recallMetadata.get(span);
    if (!metadata) {
      metadata = extractCuratedEntryRecallMetadata({
        curatedRoot: pathClassification.curatedRoot,
        projectScopeEligible:
          source === "memory" && normalizedEntryPath.toUpperCase() !== "USER.MD",
        sourceLines: sourceLines.slice(start - 1, end),
      });
      recallMetadata.set(span, metadata);
    }
    return Object.assign(chunk, metadata);
  });
  if (source === "sessions" && "lineMap" in entry) {
    remapChunkLines(chunks, entry.lineMap);
  }
  return { contentHash, chunks };
}

export function resolveChunkProvenance(
  entry: Pick<MemoryIndexEntry, "lineProvenance" | "mtimeMs">,
  source: MemorySource,
  chunk: MemoryChunk,
  pathOriginClass: MemoryEntryProvenance["originClass"],
): MemoryEntryProvenance {
  const lineProvenance = entry.lineProvenance?.slice(chunk.startLine - 1, chunk.endLine) ?? [];
  if (source === "sessions" && lineProvenance.length > 0) {
    const originPriority = ["owner", "agent", "system", "untrusted"] as const;
    const originClass = originPriority.findLast((origin) =>
      lineProvenance.some((item) => item.originClass === origin),
    );
    const sessionKinds = new Set(lineProvenance.map((item) => item.sessionKind));
    const supersedesKeys = new Set(
      lineProvenance.flatMap((item) => (item.supersedesKey ? [item.supersedesKey] : [])),
    );
    return {
      originClass: originClass ?? "untrusted",
      sessionKind:
        sessionKinds.size === 1 ? (lineProvenance[0]?.sessionKind ?? "unknown") : "unknown",
      observedAt: Math.max(...lineProvenance.map((item) => item.observedAt)),
      ...(supersedesKeys.size === 1 ? { supersedesKey: [...supersedesKeys][0] } : {}),
    };
  }

  // Workspace memory files are inside the operator trust boundary: any
  // filesystem writer already owns the host. Defaulting them untrusted would
  // silently make handwritten persona memory ineligible for dreaming.
  return {
    originClass: pathOriginClass,
    sessionKind: "unknown",
    observedAt: Math.max(0, Math.floor(entry.mtimeMs)),
  };
}
