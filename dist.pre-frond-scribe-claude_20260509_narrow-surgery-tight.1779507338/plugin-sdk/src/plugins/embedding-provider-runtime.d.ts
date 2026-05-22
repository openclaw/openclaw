import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listRegisteredEmbeddingProviders, type EmbeddingProviderAdapter } from "./embedding-providers.js";
export { listRegisteredEmbeddingProviders };
export declare function listRegisteredEmbeddingProviderAdapters(): EmbeddingProviderAdapter[];
export declare function listEmbeddingProviders(cfg?: OpenClawConfig): EmbeddingProviderAdapter[];
export declare function getEmbeddingProvider(id: string, cfg?: OpenClawConfig): EmbeddingProviderAdapter | undefined;
export type { EmbeddingInput, EmbeddingProvider, EmbeddingProviderAdapter, EmbeddingProviderCallOptions, EmbeddingProviderCreateOptions, EmbeddingProviderCreateResult, EmbeddingProviderRuntime, RegisteredEmbeddingProvider, } from "./embedding-providers.js";
