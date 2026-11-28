import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { copyProviderCapabilityModels } from "../plugins/provider-catalog-result.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { fingerprintPluginCatalogCredential } from "./plugin-model-catalog-auth.js";
import { isGeneratedPluginModelCatalog } from "./plugin-model-catalog-repair.js";
import { filterGeneratedPluginModelCatalogProviders } from "./plugin-model-catalog.js";
import type { PersistedPluginModelCatalog } from "./plugin-model-catalog.kernel.js";
import type { ProviderAuthResolver } from "./provider-auth-resolver.types.js";

/** Admit typed rows only for their original source and currently selected credential. */
export function readPersistedPluginCapabilityModels(params: {
  catalogs: readonly PersistedPluginModelCatalog[];
  config: OpenClawConfig;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
  resolveProviderAuth: ProviderAuthResolver;
}): ModelCatalogEntry[] {
  const sourceFingerprint = resolveInstalledManifestRegistryIndexFingerprint(
    params.pluginMetadataSnapshot.index,
  );
  return params.catalogs.flatMap(({ pluginId, contents }) => {
    const catalog = safeParseJsonRecord(contents);
    const providers = asOptionalRecord(catalog?.providers);
    const observations = asOptionalRecord(catalog?.capabilityModelObservations);
    if (
      !catalog ||
      !providers ||
      !isGeneratedPluginModelCatalog(catalog) ||
      observations?.sourceFingerprint !== sourceFingerprint ||
      !Array.isArray(observations.accounts)
    ) {
      return [];
    }
    return observations.accounts.flatMap((value) => {
      const observation = asOptionalRecord(value);
      if (
        !observation ||
        typeof observation.provider !== "string" ||
        typeof observation.credentialFingerprint !== "string"
      ) {
        return [];
      }
      const auth = params.resolveProviderAuth(observation.provider);
      if (
        observation.configuredBaseUrl !==
          findNormalizedProviderValue(params.config.models?.providers, observation.provider)
            ?.baseUrl ||
        observation.profileId !== auth.profileId ||
        observation.credentialFingerprint !== fingerprintPluginCatalogCredential(auth)
      ) {
        return [];
      }
      return copyProviderCapabilityModels(observation.models).filter(
        (model) =>
          model.provider === observation.provider &&
          Object.hasOwn(providers, model.provider) &&
          Object.hasOwn(
            filterGeneratedPluginModelCatalogProviders({
              catalogPluginId: pluginId,
              config: params.config,
              parsedCatalog: catalog,
              pluginMetadataSnapshot: params.pluginMetadataSnapshot,
              providers: { [model.provider]: model },
            }),
            model.provider,
          ),
      );
    });
  });
}
