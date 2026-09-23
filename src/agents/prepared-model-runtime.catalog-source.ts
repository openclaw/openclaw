import type { PreparedModelCatalogAuth } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.facts.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";

export function preparedProviderCatalogSource(
  facts: PreparedModelRuntimeAgentFacts,
  generation: PreparedModelRuntimePluginGeneration,
  provider: string,
  normalize: (provider: string) => string,
): string {
  const { config } = facts.input;
  const pluginIds = generation.pluginMetadataSnapshot.owners.providers.get(provider) ?? [];
  const providerEntries = <T>(entries: Record<string, T> | undefined) =>
    Object.fromEntries(Object.entries(entries ?? {}).filter(([id]) => normalize(id) === provider));
  return fingerprintPreparedRuntimeFacts({
    models: { ...config.models, providers: providerEntries(config.models?.providers) },
    auth: {
      profiles: Object.fromEntries(
        Object.entries(config.auth?.profiles ?? {}).filter(
          ([, profile]) => normalize(profile.provider) === provider,
        ),
      ),
      order: providerEntries(config.auth?.order),
    },
    plugins: {
      ...config.plugins,
      allow: config.plugins?.allow?.filter((id) => pluginIds.includes(id)),
      deny: config.plugins?.deny?.filter((id) => pluginIds.includes(id)),
      entries: Object.fromEntries(pluginIds.map((id) => [id, config.plugins?.entries?.[id]])),
    },
    env: { config: config.env, runtime: facts.env },
  });
}

export function preparedProviderCatalogCredentials(
  source: Pick<PreparedModelCatalogAuth, "authStore" | "credentials">,
  provider: string,
  normalize: (provider: string) => string,
): string {
  const { authStore, credentials } = source;
  return fingerprintPreparedRuntimeFacts({
    profiles: Object.fromEntries(
      Object.entries(authStore.profiles).filter(
        ([, profile]) => normalize(profile.provider) === provider,
      ),
    ),
    credentials: Object.fromEntries(
      Object.entries(credentials ?? {}).filter(([id]) => normalize(id) === provider),
    ),
    order: Object.fromEntries(
      Object.entries(authStore.order ?? {}).filter(([id]) => normalize(id) === provider),
    ),
  });
}
