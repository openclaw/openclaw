import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveDefaultAgentId } from "../agent-scope.js";
import {
  createModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
} from "../model-catalog-decisions.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../model-catalog.types.js";
import { getPreparedModelRuntimeAuthStore } from "../prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import type { AgentHarness } from "./types.js";

function findOwnedEntry(
  catalog: ModelCatalogSnapshot | undefined,
  provider: string,
  modelId: string,
  runtimeId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  return catalog?.entries.find(
    (entry) =>
      normalizeProviderId(entry.provider) === normalizedProvider &&
      entry.id === modelId &&
      entry.nativeRuntime === runtimeId,
  );
}

/**
 * Resolves a first-turn model only from a current native catalog observation owned by
 * the selected harness. Catalog membership alone is not readiness or auth evidence.
 */
export async function resolveReadyNativeModelCatalogEntry(params: {
  snapshot: PreparedModelRuntimeSnapshot | undefined;
  harness: AgentHarness;
  provider: string;
  modelId: string;
}): Promise<ModelCatalogEntry | undefined> {
  const { snapshot, harness, provider, modelId } = params;
  if (
    !snapshot ||
    !harness.loadModelCatalog ||
    !harness.readModelCatalogReadiness ||
    !snapshot.isCurrent()
  ) {
    return undefined;
  }
  const ownerHarness = snapshot.pluginRegistry?.agentHarnesses.find(
    (registration) => registration.harness.id === harness.id,
  )?.harness;
  if (ownerHarness !== harness) {
    return undefined;
  }

  let catalog = snapshot.readFullModelCatalog?.() ?? snapshot.modelCatalog;
  let entry =
    catalog.authoritative === false
      ? undefined
      : findOwnedEntry(catalog, provider, modelId, harness.id);
  if (!entry && snapshot.loadFullModelCatalog) {
    try {
      const loaded = await snapshot.loadFullModelCatalog({
        refresh: true,
        providerIds: [provider],
        foregroundWaitMs: 12_000,
      });
      // Prefer the refresh result when it contains the requested row. Some snapshots
      // publish inventory through an accessor that still points at the previous view.
      const refreshedEntry = findOwnedEntry(loaded, provider, modelId, harness.id);
      catalog = refreshedEntry ? loaded : (snapshot.readFullModelCatalog?.() ?? loaded);
    } catch {
      return undefined;
    }
    if (!snapshot.isCurrent()) {
      return undefined;
    }
    entry =
      catalog.authoritative === false
        ? undefined
        : findOwnedEntry(catalog, provider, modelId, harness.id);
  }
  if (!entry || !snapshot.isCurrent()) {
    return undefined;
  }
  const authStore = getPreparedModelRuntimeAuthStore(snapshot);
  if (!authStore) {
    return undefined;
  }
  const agentId = snapshot.agentId ?? resolveDefaultAgentId(snapshot.config);
  const decisions = createModelCatalogDecisions({
    cfg: snapshot.config,
    agentId,
    agentDir: snapshot.agentDir,
    workspaceDir: snapshot.workspaceDir,
    snapshot: catalog,
    metadataSnapshot: snapshot.metadataSnapshot,
    preparedAuthStore: authStore,
    preparedRuntimeAuthModes: snapshot.authModes,
    pluginRegistry: snapshot.pluginRegistry,
    observationConfig: snapshot.observationConfig,
    isCurrent: snapshot.isCurrent,
  });
  const variants = catalog.routeVariants.filter(
    (variant) =>
      normalizeProviderId(variant.provider) === normalizeProviderId(provider) &&
      variant.id === modelId,
  );
  const host = await decisions.evaluateEntry(entry, variants, harness.id);
  const evaluation = decisions.evaluateNative(entry, host, harness.id);
  const runtime = resolveCatalogDecisionRuntime({
    cfg: snapshot.config,
    agentId,
    entry,
    evaluation,
    pluginRegistry: snapshot.pluginRegistry,
  });
  return snapshot.isCurrent() &&
    decisions.isCurrent() &&
    evaluation.availability === true &&
    evaluation.availabilityAuthoritative === true &&
    evaluation.runtimeAuth?.id === harness.id &&
    runtime?.id === harness.id
    ? entry
    : undefined;
}
