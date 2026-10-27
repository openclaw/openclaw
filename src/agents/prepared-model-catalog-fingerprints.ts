import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import type { PreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.types.js";
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.fingerprint.js";

function fingerprintPreparedModelCatalogPlugins(
  snapshot: PreparedModelCatalogWorkerInput["pluginMetadataSnapshot"],
  installedIndexFingerprint: string,
): string {
  return fingerprintPreparedRuntimeFacts({
    config: snapshot.configFingerprint ?? null,
    index: installedIndexFingerprint,
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
    pluginFingerprint: fingerprintPreparedModelCatalogPlugins(
      value.pluginMetadataSnapshot,
      value.installedIndexFingerprint,
    ),
  });
}

/** The worker's workspace slot and registration identity travel together. */
export function prepareModelCatalogWorkerContext(value: PreparedModelCatalogWorkerInput) {
  return {
    workspaceDir: value.pluginMetadataSnapshot.workspaceDir ?? value.input.workspaceDir,
    fingerprint: fingerprintPreparedModelCatalogPluginContext(value),
  };
}
