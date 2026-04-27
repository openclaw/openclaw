export type StaticModelRef = {
    provider: string;
    model: string;
};
export declare function modelKey(provider: string, model: string): string;
export declare function normalizeAnthropicModelId(model: string): string;
export declare function normalizeStaticProviderModelId(provider: string, model: string): string;
export declare function parseStaticModelRef(raw: string, defaultProvider: string): StaticModelRef | null;
export declare function resolveStaticAllowlistModelKey(raw: string, defaultProvider: string): string | null;
