import { o as SsrFPolicy } from "./ssrf-DpkM3iBz.js";
import { Oi as MemoryEmbeddingProviderCreateOptions, Ti as MemoryEmbeddingProvider } from "./types-CWJThuOe2.js";
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