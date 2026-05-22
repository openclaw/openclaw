import { o as SsrFPolicy } from "../../ssrf-C9NFk_3M.js";
import { Mi as MemoryEmbeddingProviderCreateOptions, ki as MemoryEmbeddingProvider } from "../../types-D0OCNFd4.js";
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