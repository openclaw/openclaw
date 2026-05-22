export type AutoSelectableProvider = {
    id: string;
    autoSelectOrder?: number;
};
export type ProviderSelection<TProvider> = {
    configuredProviderId?: string;
    missingConfiguredProvider: boolean;
    provider: TProvider | undefined;
};
export type ResolvedConfiguredProvider<TProvider, TConfig> = {
    ok: true;
    configuredProviderId?: string;
    provider: TProvider;
    providerConfig: TConfig;
} | {
    ok: false;
    code: "missing-configured-provider" | "no-registered-provider" | "provider-not-configured";
    configuredProviderId?: string;
    provider?: TProvider;
};
export declare function selectConfiguredOrAutoProvider<TProvider extends AutoSelectableProvider>(params: {
    configuredProviderId?: string;
    getConfiguredProvider: (providerId: string | undefined) => TProvider | undefined;
    listProviders: () => Iterable<TProvider>;
}): ProviderSelection<TProvider>;
export declare function resolveProviderRawConfig(params: {
    providerId: string;
    configuredProviderId?: string;
    providerConfigs?: Record<string, Record<string, unknown> | undefined>;
}): Record<string, unknown>;
export declare function resolveConfiguredCapabilityProvider<TConfig, TFullConfig, TProvider extends AutoSelectableProvider>(params: {
    configuredProviderId?: string;
    providerConfigs?: Record<string, Record<string, unknown> | undefined>;
    cfg: TFullConfig | undefined;
    cfgForResolve: TFullConfig;
    getConfiguredProvider: (providerId: string | undefined) => TProvider | undefined;
    listProviders: () => Iterable<TProvider>;
    resolveProviderConfig: (params: {
        provider: TProvider;
        cfg: TFullConfig;
        rawConfig: Record<string, unknown>;
    }) => TConfig;
    isProviderConfigured: (params: {
        provider: TProvider;
        cfg: TFullConfig | undefined;
        providerConfig: TConfig;
    }) => boolean;
}): ResolvedConfiguredProvider<TProvider, TConfig>;
