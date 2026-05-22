import type { ModelProviderConfig } from "../config/types.js";
type FacadeModule = {
    resolveAnthropicVertexClientRegion: (params?: {
        baseUrl?: string;
        env?: NodeJS.ProcessEnv;
    }) => string;
    resolveAnthropicVertexProjectId: (env?: NodeJS.ProcessEnv) => string | undefined;
    buildAnthropicVertexProvider: (params?: {
        env?: NodeJS.ProcessEnv;
    }) => ModelProviderConfig;
    resolveImplicitAnthropicVertexProvider: (params?: {
        env?: NodeJS.ProcessEnv;
    }) => ModelProviderConfig | null;
    mergeImplicitAnthropicVertexProvider: (params: {
        existing?: ModelProviderConfig;
        implicit: ModelProviderConfig;
    }) => ModelProviderConfig;
};
export declare const resolveAnthropicVertexClientRegion: FacadeModule["resolveAnthropicVertexClientRegion"];
export declare const resolveAnthropicVertexProjectId: FacadeModule["resolveAnthropicVertexProjectId"];
export {};
