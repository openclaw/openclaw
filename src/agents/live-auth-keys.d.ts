type CollectProviderApiKeysOptions = {
    env?: NodeJS.ProcessEnv;
    providerEnvVars?: readonly string[];
};
export declare function collectProviderApiKeys(provider: string, options?: CollectProviderApiKeysOptions): string[];
export declare function collectAnthropicApiKeys(): string[];
export declare function collectGeminiApiKeys(): string[];
export declare function isApiKeyRateLimitError(message: string): boolean;
export declare function isAnthropicRateLimitError(message: string): boolean;
export declare function isAnthropicBillingError(message: string): boolean;
export {};
