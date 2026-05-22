export declare function modelKey(provider: string, model: string): string;
export declare function normalizeStaticProviderModelId(provider: string, model: string, options?: {
    allowManifestNormalization?: boolean;
}): string;
export declare function resolveStaticAllowlistModelKey(raw: string, defaultProvider: string): string | null;
export declare function formatLiteralProviderPrefixedModelRef(provider: string, modelRef: string): string;
