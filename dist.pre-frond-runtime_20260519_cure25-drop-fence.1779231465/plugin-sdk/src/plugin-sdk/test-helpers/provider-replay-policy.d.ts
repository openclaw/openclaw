export declare function expectPassthroughReplayPolicy(params: {
    modelId: string;
    plugin: unknown;
    providerId: string;
    sanitizeThoughtSignatures?: boolean;
}): Promise<import("./provider-catalog.ts").ProviderPlugin>;
