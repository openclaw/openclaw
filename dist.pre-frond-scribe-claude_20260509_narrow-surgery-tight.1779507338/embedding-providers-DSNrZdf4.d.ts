import { i as OpenClawConfig } from "./types.openclaw-BorXMoYB.js";
import { r as EmbeddingProviderAdapter } from "./embedding-providers-Czn7THNn.js";

//#region src/plugins/embedding-provider-runtime.d.ts
declare function listEmbeddingProviders(cfg?: OpenClawConfig): EmbeddingProviderAdapter[];
declare function getEmbeddingProvider(id: string, cfg?: OpenClawConfig): EmbeddingProviderAdapter | undefined;
//#endregion
export { listEmbeddingProviders as n, getEmbeddingProvider as t };