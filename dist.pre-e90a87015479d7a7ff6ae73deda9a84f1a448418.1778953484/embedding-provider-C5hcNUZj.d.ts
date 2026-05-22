import { o as SsrFPolicy } from "./ssrf-B_L-my6p.js";
import { Di as MemoryEmbeddingProvider, ki as MemoryEmbeddingProviderCreateOptions } from "./types-CT4HF0Ri.js";
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