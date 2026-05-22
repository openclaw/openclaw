import type { ProviderPlugin } from "../provider-model-shared.js";
import type { WebFetchProviderPlugin } from "../provider-web-fetch-contract.js";
import type { WebSearchProviderPlugin } from "../provider-web-search-contract.js";
type Lazy<T> = T | (() => T);
export declare function installProviderPluginContractSuite(params: {
    provider: Lazy<ProviderPlugin>;
}): void;
export declare function installWebSearchProviderContractSuite(params: {
    provider: Lazy<WebSearchProviderPlugin>;
    credentialValue: Lazy<unknown>;
}): void;
export declare function installWebFetchProviderContractSuite(params: {
    provider: Lazy<WebFetchProviderPlugin>;
    credentialValue: Lazy<unknown>;
    pluginId?: string;
}): void;
export {};
