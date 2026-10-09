import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import type {
  PreparedModelCatalogWorkerInput,
  PreparedModelWorkerRequest,
} from "./prepared-model-catalog-worker.js";
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.facts.js";

export function fingerprintPreparedModelWorkerRequest(
  input: PreparedModelCatalogWorkerInput,
  request: PreparedModelWorkerRequest,
): string {
  return fingerprintPreparedRuntimeFacts([input.generationFingerprint, request]);
}

function fingerprintPreparedModelCatalogPlugins(
  snapshot: PreparedModelCatalogWorkerInput["pluginMetadataSnapshot"],
): string {
  return fingerprintPreparedRuntimeFacts({
    config: snapshot.configFingerprint ?? null,
    index: resolveInstalledManifestRegistryIndexFingerprint(snapshot.index),
    pluginIds: snapshot.pluginIds ?? null,
    policy: snapshot.policyHash,
    workspaceDir: snapshot.workspaceDir ?? null,
  });
}

const immutableGenerationConfigFingerprints = new WeakMap<OpenClawConfig, string>();

function fingerprintPreparedModelCatalogConfig(config: OpenClawConfig): string {
  const immutable = isDeeplyFrozenPlainData(config);
  const cached = immutable ? immutableGenerationConfigFingerprints.get(config) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  // Worker generation facts must retain the distinction between undefined and null.
  const fingerprint = fingerprintPreparedRuntimeFacts(config);
  if (immutable) {
    immutableGenerationConfigFingerprints.set(config, fingerprint);
  }
  return fingerprint;
}

export function fingerprintPreparedModelCatalogGeneration(
  params: Omit<PreparedModelCatalogWorkerInput, "generationFingerprint">,
): string {
  return fingerprintPreparedRuntimeFacts({
    remoteCatalogSource: params.remoteCatalog?.sourceUrl,
    remoteCatalogRevision: params.remoteCatalog?.revision,
    input: { ...params.input, config: fingerprintPreparedModelCatalogConfig(params.input.config) },
    sourceConfigForSecrets: fingerprintPreparedModelCatalogConfig(params.sourceConfigForSecrets),
    configResolutionFacts: params.configResolutionFacts,
    sourceConfigResolutionFacts: params.sourceConfigResolutionFacts,
    authStore: params.authStore,
    sharedAuthStoreOwnership: params.sharedAuthStoreOwnership,
    providerIds: params.providerIds,
    catalogFacts: params.catalogFacts,
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts,
    pluginFingerprint: fingerprintPreparedModelCatalogPlugins(params.pluginMetadataSnapshot),
  });
}

/** Registrations follow their loader context; agent credentials remain request-local. */
export function fingerprintPreparedModelCatalogPluginContext(
  value: PreparedModelCatalogWorkerInput,
): string {
  return fingerprintPreparedRuntimeFacts({
    remoteCatalogSource: value.remoteCatalog?.sourceUrl,
    remoteCatalogRevision: value.remoteCatalog?.revision,
    config: fingerprintPreparedModelCatalogConfig(value.input.config),
    sourceConfigForSecrets: fingerprintPreparedModelCatalogConfig(value.sourceConfigForSecrets),
    configResolutionFacts: value.configResolutionFacts,
    sourceConfigResolutionFacts: value.sourceConfigResolutionFacts,
    env: value.input.env,
    workspaceDir: value.pluginMetadataSnapshot.workspaceDir ?? value.input.workspaceDir,
    allowGatewaySubagentBinding: value.input.allowGatewaySubagentBinding === true,
    preferBuiltPluginArtifacts: value.preferBuiltPluginArtifacts,
    pluginFingerprint: fingerprintPreparedModelCatalogPlugins(value.pluginMetadataSnapshot),
  });
}
