import { n as MemoryMultimodalSettings, t as MemoryMultimodalModality } from "./multimodal-Dq8Bb48g.js";

//#region packages/memory-host-sdk/src/host/embedding-inputs.d.ts
type EmbeddingInputTextPart = {
  type: "text";
  text: string;
};
type EmbeddingInputInlineDataPart = {
  type: "inline-data";
  mimeType: string;
  data: string;
};
type EmbeddingInputPart = EmbeddingInputTextPart | EmbeddingInputInlineDataPart;
type EmbeddingInput = {
  text: string;
  parts?: EmbeddingInputPart[];
};
declare function hasNonTextEmbeddingParts(input: EmbeddingInput | undefined): boolean;
//#endregion
//#region packages/memory-host-sdk/src/host/hash.d.ts
declare function hashText(value: string): string;
//#endregion
//#region packages/memory-host-sdk/src/host/internal.d.ts
type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  dataHash?: string;
  kind?: "markdown" | "multimodal";
  contentText?: string;
  modality?: MemoryMultimodalModality;
  mimeType?: string;
};
type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embeddingInput?: EmbeddingInput;
};
type MultimodalMemoryChunk = {
  chunk: MemoryChunk;
  structuredInputBytes: number;
};
declare function ensureDir(dir: string): string;
declare function normalizeExtraMemoryPaths(workspaceDir: string, extraPaths?: string[]): string[];
declare function listMemoryFiles(workspaceDir: string, extraPaths?: string[], multimodal?: MemoryMultimodalSettings): Promise<string[]>;
declare function buildFileEntry(absPath: string, workspaceDir: string, multimodal?: MemoryMultimodalSettings): Promise<MemoryFileEntry | null>;
declare function buildMultimodalChunkForIndexing(entry: Pick<MemoryFileEntry, "absPath" | "contentText" | "mimeType" | "kind" | "hash" | "size" | "dataHash">): Promise<MultimodalMemoryChunk | null>;
declare function chunkMarkdown(content: string, chunking: {
  tokens: number;
  overlap: number;
}): MemoryChunk[];
/**
 * Remap chunk startLine/endLine from content-relative positions to original
 * source file positions using a lineMap.  Each entry in lineMap gives the
 * 1-indexed source line for the corresponding 0-indexed content line.
 *
 * This is used for session JSONL files where buildSessionEntry() flattens
 * messages into a plain-text string before chunking.  Without remapping the
 * stored line numbers would reference positions in the flattened text rather
 * than the original JSONL file.
 */
declare function remapChunkLines(chunks: MemoryChunk[], lineMap: number[] | undefined): void;
declare function parseEmbedding(raw: string): number[];
declare function cosineSimilarity(a: number[], b: number[]): number;
declare function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]>;
//#endregion
export { chunkMarkdown as a, listMemoryFiles as c, remapChunkLines as d, runWithConcurrency as f, hasNonTextEmbeddingParts as h, buildMultimodalChunkForIndexing as i, normalizeExtraMemoryPaths as l, EmbeddingInput as m, MemoryFileEntry as n, cosineSimilarity as o, hashText as p, buildFileEntry as r, ensureDir as s, MemoryChunk as t, parseEmbedding as u };