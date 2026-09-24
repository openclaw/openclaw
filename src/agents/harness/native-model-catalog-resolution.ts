import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agent-scope.js";
import {
  createModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
} from "../model-catalog-decisions.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../model-catalog.types.js";
import { getPreparedModelRuntimeAuthStore } from "../prepared-model-runtime-auth.js";
import { waitForPreparedModelCatalogForeground } from "../prepared-model-runtime.catalog-foreground-wait.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import type { AgentHarness } from "./types.js";

function findOwnedEntry(
  catalog: ModelCatalogSnapshot | undefined,
  provider: string,
  modelId: string,
  runtimeId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const matchesSelection = (entry: ModelCatalogEntry) =>
    normalizeProviderId(entry.provider) === normalizedProvider &&
    entry.id === modelId &&
    entry.nativeRuntime === runtimeId;
  return catalog?.entries.find(matchesSelection) ?? catalog?.routeVariants.find(matchesSelection);
}

export type ReadyNativeModelCatalogSelection = {
  entry: ModelCatalogEntry;
  assertCurrent?: () => void;
};

/**
 * Resolves a first-turn model only from a current native catalog observation owned by
 * the selected harness. Catalog membership alone is not readiness or auth evidence.
 */
export async function resolveReadyNativeModelCatalogEntry(params: {
  snapshot: PreparedModelRuntimeSnapshot | undefined;
  harness: AgentHarness;
  provider: string;
  modelId: string;
}): Promise<ReadyNativeModelCatalogSelection | undefined> {
  const { snapshot, harness, provider, modelId } = params;
  if (!snapshot || !harness.loadModelCatalog || !snapshot.isCurrent()) {
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
  if (!entry && snapshot.loadNativeModelCatalog) {
    try {
      let acquiredCatalog: ModelCatalogSnapshot | undefined;
      let selectedRowReady = false;
      let waitingForSelection = true;
      const acquisition = snapshot
        .loadNativeModelCatalog(
          {
            provider,
            modelId,
            runtime: harness.id,
          },
          {
            onSelectionReady: (ready) => {
              if (waitingForSelection) {
                selectedRowReady = ready;
              }
            },
          },
        )
        .then((loaded) => {
          acquiredCatalog = loaded;
          return loaded;
        });
      let loaded: ModelCatalogSnapshot;
      try {
        loaded = await waitForPreparedModelCatalogForeground({
          acquisition,
          waitMs: 12_000,
          fallback: () => snapshot.readFullModelCatalog?.() ?? snapshot.modelCatalog,
        });
      } finally {
        waitingForSelection = false;
      }
      // The selected-provider attestation is independent of unrelated retained failures.
      // Timeout fallbacks and failed selected refreshes never attest their exact row.
      const completedTargetedAcquisition = loaded === acquiredCatalog && selectedRowReady;
      // Prefer an authoritative refresh result when it contains the requested row. Some
      // snapshots publish inventory through an accessor that still points at the previous view.
      const refreshedEntry =
        loaded.authoritative === false && !completedTargetedAcquisition
          ? undefined
          : findOwnedEntry(loaded, provider, modelId, harness.id);
      if (refreshedEntry) {
        // Partial inventory is usable only for the selected row proven by this completed
        // exact-runtime acquisition; other callers still require an authoritative snapshot.
        catalog = loaded;
        entry = refreshedEntry;
      } else {
        catalog = snapshot.readFullModelCatalog?.() ?? loaded;
        entry =
          catalog.authoritative === false
            ? undefined
            : findOwnedEntry(catalog, provider, modelId, harness.id);
      }
    } catch {
      return undefined;
    }
    if (!snapshot.isCurrent()) {
      return undefined;
    }
  } else if (!entry && snapshot.loadFullModelCatalog) {
    try {
      const loaded = await snapshot.loadFullModelCatalog({
        refresh: true,
        providerIds: [provider],
        foregroundWaitMs: 12_000,
      });
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
  if (
    !snapshot.isCurrent() ||
    !decisions.isCurrent() ||
    evaluation.availability !== true ||
    evaluation.availabilityAuthoritative !== true ||
    evaluation.runtimeAuth?.id !== harness.id ||
    runtime?.id !== harness.id
  ) {
    return undefined;
  }
  let assertCurrent: (() => void) | undefined;
  if (harness.captureModelCatalogSelectionAuthority) {
    try {
      assertCurrent = harness.captureModelCatalogSelectionAuthority({
        config: snapshot.config,
        agentId,
        agentDir: snapshot.agentDir,
        workspaceDir: snapshot.workspaceDir ?? resolveAgentWorkspaceDir(snapshot.config, agentId),
        provider,
        modelId,
      });
    } catch {
      return undefined;
    }
    if (!assertCurrent) {
      return undefined;
    }
  }
  if (!snapshot.isCurrent() || !decisions.isCurrent()) {
    return undefined;
  }
  try {
    assertCurrent?.();
  } catch {
    return undefined;
  }
  return { entry, ...(assertCurrent ? { assertCurrent } : {}) };
}
