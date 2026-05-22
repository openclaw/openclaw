import { o as SsrFPolicy } from "./ssrf-skjEI_i5.js";
import { Mi as MemoryEmbeddingProviderCreateOptions, ki as MemoryEmbeddingProvider } from "./types-WgmX6DKe.js";
//#region extensions/openai/embedding-provider.d.ts
type OpenAiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  model: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  outputDimensionality?: number;
};
declare const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
declare function createOpenAiEmbeddingProvider(options: MemoryEmbeddingProviderCreateOptions): Promise<{
  provider: MemoryEmbeddingProvider;
  client: OpenAiEmbeddingClient;
}>;
//#endregion
export { OpenAiEmbeddingClient as n, createOpenAiEmbeddingProvider as r, DEFAULT_OPENAI_EMBEDDING_MODEL as t };