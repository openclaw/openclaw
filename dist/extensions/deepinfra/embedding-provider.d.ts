import { Di as MemoryEmbeddingProviderCreateResult, Ei as MemoryEmbeddingProviderCreateOptions } from "../../types-lCXG2pW_.js";
import { c as DEFAULT_DEEPINFRA_EMBEDDING_MODEL } from "../../media-models-BHdnq0H7.js";

//#region extensions/deepinfra/embedding-provider.d.ts
declare function createDeepInfraEmbeddingProvider(options: MemoryEmbeddingProviderCreateOptions): Promise<MemoryEmbeddingProviderCreateResult & {
  client: {
    model: string;
  };
}>;
//#endregion
export { DEFAULT_DEEPINFRA_EMBEDDING_MODEL, createDeepInfraEmbeddingProvider };