import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type ExternalCliAuthDiscovery = {
    mode: "none";
    allowKeychainPrompt?: false;
    config?: OpenClawConfig;
} | {
    mode: "existing";
    allowKeychainPrompt?: boolean;
    config?: OpenClawConfig;
} | {
    mode: "scoped";
    allowKeychainPrompt?: boolean;
    config?: OpenClawConfig;
    providerIds?: Iterable<string>;
    profileIds?: Iterable<string>;
};
type ProviderAuthDiscoveryParams = {
    cfg?: OpenClawConfig;
    provider: string;
    profileId?: string;
    preferredProfile?: string;
    allowKeychainPrompt?: boolean;
};
type ConfigStatusDiscoveryParams = {
    cfg: OpenClawConfig;
    allowKeychainPrompt?: false;
};
type ProviderSetDiscoveryParams = {
    cfg?: OpenClawConfig;
    providers: Iterable<string>;
    allowKeychainPrompt?: false;
};
export declare function externalCliDiscoveryNone(params?: {
    config?: OpenClawConfig;
}): ExternalCliAuthDiscovery;
export declare function externalCliDiscoveryExisting(params?: {
    config?: OpenClawConfig;
    allowKeychainPrompt?: boolean;
}): ExternalCliAuthDiscovery;
export declare function externalCliDiscoveryScoped(params: {
    config?: OpenClawConfig;
    providerIds?: Iterable<string>;
    profileIds?: Iterable<string>;
    allowKeychainPrompt?: boolean;
}): ExternalCliAuthDiscovery;
export declare function externalCliDiscoveryForProviderAuth(params: ProviderAuthDiscoveryParams): ExternalCliAuthDiscovery;
export declare function externalCliDiscoveryForConfigStatus(params: ConfigStatusDiscoveryParams): ExternalCliAuthDiscovery;
export declare function externalCliDiscoveryForProviders(params: ProviderSetDiscoveryParams): ExternalCliAuthDiscovery;
export {};
