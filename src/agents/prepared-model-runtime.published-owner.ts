import {
  getPreparedSharedAuthStoreOwnership,
  prepareSharedAuthStoreOwnership,
} from "./auth-profiles/path-resolve.js";
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
  if (!getPreparedSharedAuthStoreOwnership(rawInput.env ?? process.env)) {
    await prepareSharedAuthStoreOwnership(rawInput.env);
  }
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
    return await projectNormalizedModelRuntimeOwner(input, context, project, assertLifetime);
  } catch (error) {
    if (!isPreparedModelRuntimeMissingOwnerError(error)) {
      throw error;
    }
  }
  await activateStandalone(input);
  assertLifetime();
  // Concurrent reloads may make this request fail; the next request uses the new owner.
  return await projectNormalizedModelRuntimeOwner(input, context, project, assertLifetime);
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

/** Prepare raw read inputs once before projecting their published owner. */
async function projectPublishedModelRuntimeOwner<T>(
  rawInput: PreparedModelRuntimeInput,
  context: PublishedModelRuntimeContext,
  project: (owner: PreparedModelRuntimeOwner, snapshot: PreparedModelRuntimeSnapshot) => T,
): Promise<T> {
  const assertLifetime = context.captureLifetime();
  if (!getPreparedSharedAuthStoreOwnership(rawInput.env ?? process.env)) {
    await prepareSharedAuthStoreOwnership(rawInput.env);
  }
  assertLifetime();
  const input = normalizePreparedModelRuntimeInput(rawInput);
  // Explicit empty raw fields constrain lookup even when normalization omits them.
  return await projectNormalizedModelRuntimeOwner(
    input,
    context,
    project,
    assertLifetime,
    rawInput.workspaceDir === undefined ||
      rawInput.agentId === undefined ||
      rawInput.runtimePluginSelections === undefined,
  );
}

/** Retain normalized read facts, including their lifetime, across publication waits. */
async function projectNormalizedModelRuntimeOwner<T>(
  input: PreparedModelRuntimeInput,
  context: PublishedModelRuntimeContext,
  project: (owner: PreparedModelRuntimeOwner, snapshot: PreparedModelRuntimeSnapshot) => T,
  assertLifetime: () => void,
  allowConfiguredWorkspaceFallback = input.workspaceDir === undefined ||
    input.agentId === undefined ||
    input.runtimePluginSelections === undefined,
): Promise<T> {
  let replacement = context.getPendingReplacement(input);
  // A superseded gate resolves early; follow its successors like lease admission does.
  for (let waits = 0; replacement && waits < 3; waits += 1) {
    assertPreparedModelRuntimeAdmissionCanWait();
    await replacement.promise;
    assertLifetime();
    replacement = context.getPendingReplacement(input);
  }
  const existing = resolvePublishedOwner(context.owners, input, {
    allowConfiguredWorkspaceFallback,
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
  if (existing?.pending) {
    assertPreparedModelRuntimeAdmissionCanWait(existing);
    await existing.pending;
    assertLifetime();
  }
  // An overlapping reload may fail this read; the next request selects its replacement.
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
