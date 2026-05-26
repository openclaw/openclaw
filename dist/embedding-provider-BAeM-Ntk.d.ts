import { o as SsrFPolicy } from "./ssrf-skjEI_i5.js";
import { Ri as MemoryEmbeddingProvider, Vi as MemoryEmbeddingProviderCreateOptions } from "./types-Vx7Jq4_-2.js";
//#region extensions/voyage/embedding-provider.d.ts
type VoyageEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};
declare const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";
declare function createVoyageEmbeddingProvider(options: MemoryEmbeddingProviderCreateOptions): Promise<{
  provider: MemoryEmbeddingProvider;
  client: VoyageEmbeddingClient;
}>;
//#endregion
export { VoyageEmbeddingClient as n, createVoyageEmbeddingProvider as r, DEFAULT_VOYAGE_EMBEDDING_MODEL as t };