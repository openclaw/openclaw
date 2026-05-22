import { bi as MemoryEmbeddingProviderCreateResult, yi as MemoryEmbeddingProviderCreateOptions } from "../../types-DaukV8xd.js";
import { c as DEFAULT_DEEPINFRA_EMBEDDING_MODEL } from "../../media-models-RiUFDPWv.js";

//#region extensions/deepinfra/embedding-provider.d.ts
declare function createDeepInfraEmbeddingProvider(options: MemoryEmbeddingProviderCreateOptions): Promise<MemoryEmbeddingProviderCreateResult & {
  client: {
    model: string;
  };
}>;
//#endregion
export { DEFAULT_DEEPINFRA_EMBEDDING_MODEL, createDeepInfraEmbeddingProvider };