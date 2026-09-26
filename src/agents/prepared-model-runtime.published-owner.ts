import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { capturePreparedModelRuntimeCatalog } from "./prepared-model-runtime.capture.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  normalizePreparedModelRuntimeInput,
  ownerKey,
  preparedModelRuntimeConfigsMatch,
  resolvePreparedModelRuntimeOwnerBySnapshot,
  resolvePublishedOwner,
} from "./prepared-model-runtime.owner.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import type {
  PreparedModelCatalogRefreshOptions,
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLease,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeReplacement,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

export async function refreshPublishedModelRuntimeCatalog(
  snapshot: PreparedModelRuntimeSnapshot,
  owners: ReadonlyMap<string, PreparedModelRuntimeOwner>,
  options: PreparedModelCatalogRefreshOptions,
): Promise<ModelCatalogSnapshot | undefined> {
  const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
  if (!owner || owners.get(ownerKey(owner.input)) !== owner || !snapshot.loadFullModelCatalog) {
    return undefined;
  }
  const currentCatalog = snapshot.readFullModelCatalog?.() ?? snapshot.modelCatalog;
  const refresh = options.refresh === true || owner.catalogStale;
  if (
    !refresh &&
    !options.providerIds &&
    !options.changedOnly &&
    isPreparedModelCatalogFull(currentCatalog)
  ) {
    return undefined;
  }
  const generation = owner.generation;
  const catalog = await snapshot.loadFullModelCatalog({ ...options, refresh });
  if (
    owner.catalogStale &&
    !catalog.pendingProviders?.length &&
    owner.generation === generation &&
    owners.get(ownerKey(owner.input)) === owner
  ) {
    owner.catalogStale = false;
  }
  return catalog;
}

export function retainPublishedModelRuntimeOwner(
  owner: PreparedModelRuntimeOwner,
  snapshot: PreparedModelRuntimeSnapshot,
): PreparedModelRuntimeLease {
  const pluginGeneration = owner.pluginGeneration;
  if (!pluginGeneration) {
    throw new Error("Published model runtime has no plugin generation");
  }
  return {
    snapshot: capturePreparedModelRuntimeCatalog(snapshot, snapshot),
    pluginGeneration,
    [Symbol.asyncDispose]: retainPreparedPluginGeneration(pluginGeneration),
  };
}

type PublishedModelRuntimeContext = {
  captureLifetime(): () => void;
  getPendingReplacement(): PreparedModelRuntimeReplacement | undefined;
  owners: Map<string, PreparedModelRuntimeOwner>;
};

/** Project or retain the exact published owner before its snapshot crosses an await. */
export async function projectPublishedModelRuntimeOwner<T>(
  rawInput: PreparedModelRuntimeInput,
  context: PublishedModelRuntimeContext,
  project: (owner: PreparedModelRuntimeOwner, snapshot: PreparedModelRuntimeSnapshot) => T,
): Promise<T> {
  const assertLifetime = context.captureLifetime();
  const replacement = context.getPendingReplacement();
  if (replacement) {
    // Individual owners may finish before a multi-owner publication commits. The lifecycle gate
    // makes the generation visible atomically only after every owner and auth mutation is ready.
    await replacement.promise;
    assertLifetime();
    return await projectPublishedModelRuntimeOwner(rawInput, context, project);
  }
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const existing = resolvePublishedOwner(context.owners, input, {
    allowConfiguredWorkspaceFallback:
      rawInput.workspaceDir === undefined ||
      rawInput.agentId === undefined ||
      rawInput.runtimePluginSelections === undefined,
  });
  if (
    input.readOnly &&
    existing &&
    !preparedModelRuntimeConfigsMatch(existing.input.config, input.config)
  ) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared read-only model runtime owner was not published for the requested config (${input.agentDir})`,
    );
  }
  // Generated catalogs are lifecycle artifacts, not a live-edit surface. Config/plugin reload,
  // doctor/auth repair, and auth publication replace owners; external edits require restart.
  if (existing?.pending) {
    try {
      await existing.pending;
    } catch {
      // Re-read the owner below so a superseding generation wins over this result or error.
    }
    assertLifetime();
    return await projectPublishedModelRuntimeOwner(rawInput, context, project);
  }
  if (existing?.needsRefresh) {
    throw existing.refreshError ?? new Error("prepared model runtime refresh is pending");
  }
  if (existing?.snapshot) {
    return project(existing, existing.snapshot);
  }
  throw new PreparedModelRuntimeOwnerNotPublishedError(
    `prepared model runtime owner was not published for ${input.agentDir}`,
  );
}
