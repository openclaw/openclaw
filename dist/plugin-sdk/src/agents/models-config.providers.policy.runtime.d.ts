import type { ProviderConfig } from "./models-config.providers.secrets.js";
export declare function applyProviderNativeStreamingUsagePolicy(providerKey: string, provider: ProviderConfig): ProviderConfig;
export declare function normalizeProviderConfigPolicy(providerKey: string, provider: ProviderConfig): ProviderConfig;
export declare function resolveProviderConfigApiKeyPolicy(providerKey: string, provider?: ProviderConfig): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined;
