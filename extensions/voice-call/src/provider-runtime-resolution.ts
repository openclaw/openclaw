import { resolveProviderRawConfig, selectConfiguredOrAutoProvider } from "./provider-selection.js";

type AutoSelectableProvider = {
  id: string;
  autoSelectOrder?: number;
};

type ConfigurableProvider<TConfig, TFullConfig> = AutoSelectableProvider & {
  resolveConfig?: (params: { cfg: TFullConfig; rawConfig: Record<string, unknown> }) => TConfig;
  isConfigured: (params: { cfg: TFullConfig | undefined; providerConfig: TConfig }) => boolean;
};

export type ResolvedConfiguredProvider<TProvider, TConfig> =
  | {
      ok: true;
      configuredProviderId?: string;
      provider: TProvider;
      providerConfig: TConfig;
    }
  | {
      ok: false;
      code: "missing-configured-provider" | "no-registered-provider" | "provider-not-configured";
      configuredProviderId?: string;
      provider?: TProvider;
    };

export function resolveConfiguredCapabilityProvider<
  TConfig,
  TFullConfig,
  TProvider extends ConfigurableProvider<TConfig, TFullConfig>,
>(params: {
  configuredProviderId?: string;
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
  cfg: TFullConfig | undefined;
  cfgForResolve: TFullConfig;
  getConfiguredProvider: (providerId: string | undefined) => TProvider | undefined;
  listProviders: () => Iterable<TProvider>;
}): ResolvedConfiguredProvider<TProvider, TConfig> {
  const selection = selectConfiguredOrAutoProvider({
    configuredProviderId: params.configuredProviderId,
    getConfiguredProvider: params.getConfiguredProvider,
    listProviders: params.listProviders,
  });
  if (selection.missingConfiguredProvider) {
    return {
      ok: false,
      code: "missing-configured-provider",
      configuredProviderId: selection.configuredProviderId,
    };
  }

  const provider = selection.provider;
  if (!provider) {
    return {
      ok: false,
      code: "no-registered-provider",
      configuredProviderId: selection.configuredProviderId,
    };
  }

  const rawProviderConfig = resolveProviderRawConfig({
    providerId: provider.id,
    configuredProviderId: selection.configuredProviderId,
    providerConfigs: params.providerConfigs,
  });
  const providerConfig =
    provider.resolveConfig?.({
      cfg: params.cfgForResolve,
      rawConfig: rawProviderConfig,
    }) ?? (rawProviderConfig as TConfig);

  if (!provider.isConfigured({ cfg: params.cfg, providerConfig })) {
    return {
      ok: false,
      code: "provider-not-configured",
      configuredProviderId: selection.configuredProviderId,
      provider,
    };
  }

  return {
    ok: true,
    configuredProviderId: selection.configuredProviderId,
    provider,
    providerConfig,
  };
}
