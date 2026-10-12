import { prepareSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { assertPreparedModelRuntimeAdmissionCanWait } from "./prepared-model-runtime-admission.js";
import { capturePreparedModelRuntimeCatalog } from "./prepared-model-runtime.capture.js";
import { isPreparedModelRuntimeMissingOwnerError } from "./prepared-model-runtime.errors.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  normalizePreparedModelRuntimeInput,
  ownerKey,
  preparedModelRuntimeConfigsMatch,
  rebindInputToCommittedConfiguredOwner,
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
  const catalog = await snapshot.loadFullModelCatalog({ ...options, refresh });
  if (owner.catalogStale && !catalog.pendingProviders?.length) {
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
  getPendingReplacement(
    input?: PreparedModelRuntimeInput,
  ): PreparedModelRuntimeReplacement | undefined;
  owners: Map<string, PreparedModelRuntimeOwner>;
};

/** Loads a published owner or delegates missing-owner activation to its lifecycle boundary. */
export async function loadPreparedModelRuntimeOwner<T>(
  rawInput: PreparedModelRuntimeInput,
  context: PublishedModelRuntimeContext,
  activateStandalone: (
    input: PreparedModelRuntimeInput,
  ) => Promise<PreparedModelRuntimeSnapshot | undefined>,
  project: (owner: PreparedModelRuntimeOwner, snapshot: PreparedModelRuntimeSnapshot) => T,
): Promise<T> {
  const assertLifetime = context.captureLifetime();
  await prepareSharedAuthStoreOwnership(rawInput.env);
  assertLifetime();
  let input = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  assertLifetime();
  const replacement = context.getPendingReplacement(input);
  if (replacement) {
    assertPreparedModelRuntimeAdmissionCanWait();
    await replacement.promise;
    assertLifetime();
    input = rebindInputToCommittedConfiguredOwner(context.owners, input);
  }
  try {
    return await projectPublishedModelRuntimeOwner(input, context, project);
  } catch (error) {
    if (!isPreparedModelRuntimeMissingOwnerError(error)) {
      throw error;
    }
  }
  await activateStandalone(input);
  // Concurrent reloads may make this request fail; the next request uses the new owner.
  return await projectPublishedModelRuntimeOwner(input, context, project);
}

/** Bind passive reads and retained acquisitions to the same publication owner. */
export function createPublishedModelRuntimeAccess(
  context: PublishedModelRuntimeContext,
  getPublishedReplacement: PublishedModelRuntimeContext["getPendingReplacement"],
) {
  const readContext = { ...context, getPendingReplacement: getPublishedReplacement };
  return {
    acquire: (input: PreparedModelRuntimeInput) =>
      projectPublishedModelRuntimeOwner(input, context, retainPublishedModelRuntimeOwner),
    prepare: (input: PreparedModelRuntimeInput, options: { readPublished?: boolean } = {}) =>
      projectPublishedModelRuntimeOwner(
        input,
        options.readPublished ? readContext : context,
        (_owner, snapshot) => snapshot,
      ),
  };
}

/** Project or retain the exact published owner before its snapshot crosses an await. */
async function projectPublishedModelRuntimeOwner<T>(
  rawInput: PreparedModelRuntimeInput,
  context: PublishedModelRuntimeContext,
  project: (owner: PreparedModelRuntimeOwner, snapshot: PreparedModelRuntimeSnapshot) => T,
): Promise<T> {
  const assertLifetime = context.captureLifetime();
  await prepareSharedAuthStoreOwnership(rawInput.env);
  assertLifetime();
  const input = normalizePreparedModelRuntimeInput(rawInput);
  let replacement = context.getPendingReplacement(input);
  while (replacement) {
    // Individual owners may finish before a multi-owner publication commits. The lifecycle gate
    // makes the generation visible atomically only after every owner and auth mutation is ready.
    assertPreparedModelRuntimeAdmissionCanWait();
    await replacement.promise;
    assertLifetime();
    // Superseding a gate wakes its readers before the successor has committed.
    replacement = context.getPendingReplacement(input);
  }
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
    // Auth republication may be queued behind plugin drainage even for passive metadata reads.
    assertPreparedModelRuntimeAdmissionCanWait(existing);
    try {
      await existing.pending;
    } catch {
      // Preserve the owner's recorded publication error below.
    }
    assertLifetime();
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
