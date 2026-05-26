import { Hi as MemoryEmbeddingProviderCreateResult, Vi as MemoryEmbeddingProviderCreateOptions } from "../../types-Vx7Jq4_-2.js";
import { c as DEFAULT_DEEPINFRA_EMBEDDING_MODEL } from "../../media-models-CRufXipe.js";

//#region extensions/deepinfra/embedding-provider.d.ts
declare function createDeepInfraEmbeddingProvider(options: MemoryEmbeddingProviderCreateOptions): Promise<MemoryEmbeddingProviderCreateResult & {
  client: {
    model: string;
  };
}>;
//#endregion
export { DEFAULT_DEEPINFRA_EMBEDDING_MODEL, createDeepInfraEmbeddingProvider };