import { Mi as MemoryEmbeddingProviderCreateOptions, Ni as MemoryEmbeddingProviderCreateResult } from "../../types-CPAF_tyr.js";
import { c as DEFAULT_DEEPINFRA_EMBEDDING_MODEL } from "../../media-models-Bdrq2TOC.js";

//#region extensions/deepinfra/embedding-provider.d.ts
declare function createDeepInfraEmbeddingProvider(options: MemoryEmbeddingProviderCreateOptions): Promise<MemoryEmbeddingProviderCreateResult & {
  client: {
    model: string;
  };
}>;
//#endregion
export { DEFAULT_DEEPINFRA_EMBEDDING_MODEL, createDeepInfraEmbeddingProvider };