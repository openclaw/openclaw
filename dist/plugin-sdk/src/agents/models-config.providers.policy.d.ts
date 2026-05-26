import type { ProviderConfig } from "./models-config.providers.secrets.js";
export declare function applyNativeStreamingUsageCompat(providers: Record<string, ProviderConfig>): Record<string, ProviderConfig>;
export declare function normalizeProviderSpecificConfig(providerKey: string, provider: ProviderConfig): ProviderConfig;
export declare function resolveProviderConfigApiKeyResolver(providerKey: string, provider?: ProviderConfig): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined;
