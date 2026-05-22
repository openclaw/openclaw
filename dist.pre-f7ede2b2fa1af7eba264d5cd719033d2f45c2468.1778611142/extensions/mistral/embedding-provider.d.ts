import { o as SsrFPolicy } from "../../ssrf-DAZxh7gy.js";
import { Di as MemoryEmbeddingProvider, ki as MemoryEmbeddingProviderCreateOptions } from "../../types-DKA4S1yN.js";
//#region extensions/mistral/embedding-provider.d.ts
type MistralEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};
declare const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
declare function createMistralEmbeddingProvider(options: MemoryEmbeddingProviderCreateOptions): Promise<{
  provider: MemoryEmbeddingProvider;
  client: MistralEmbeddingClient;
}>;
//#endregion
export { DEFAULT_MISTRAL_EMBEDDING_MODEL, createMistralEmbeddingProvider };