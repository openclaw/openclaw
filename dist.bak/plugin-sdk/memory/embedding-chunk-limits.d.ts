import type { EmbeddingProvider } from "./embeddings.js";
import { type MemoryChunk } from "./internal.js";
export declare function enforceEmbeddingMaxInputTokens(provider: EmbeddingProvider, chunks: MemoryChunk[], hardMaxInputTokens?: number): MemoryChunk[];
