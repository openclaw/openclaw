/** Lifecycle-owned auth/model discovery snapshots for agent runs. */
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { registerRuntimeAuthProfileStoreMutationListener } from "./auth-profiles/runtime-snapshots.js";
import {
  PreparedModelRuntimeAuthPublicationOwner,
  invalidatePreparedModelRuntimeOwnersForAuthMutation,
  type PreparedModelRuntimeAuthMutation,
} from "./prepared-model-runtime-auth-publication.js";
import { acquirePreparedModelRuntimeLeaseFromOwners } from "./prepared-model-runtime-lease.js";
import {
  configuredOwnersAreRequestVisible,
  registerPreparedRuntimeAuthMaterializationPublisher,
} from "./prepared-model-runtime-materializations.js";
import { PreparedModelCatalogGenerationRecoveryOwner } from "./prepared-model-runtime.catalog-generation-recovery.js";
import {
  advancePreparedModelRuntimeOwnersConfig,
  createPreparedModelRuntimeCatalogRefresh,
} from "./prepared-model-runtime.catalog.js";
import { refreshPreparedModelRuntimeSnapshotsNow } from "./prepared-model-runtime.configured-refresh.js";
import {
  capturePreparedModelRuntimeLifetime,
  closePreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimeClose,
  createPreparedModelRuntimeReplacement,
  retirePreparedModelRuntimeGeneration,
} from "./prepared-model-runtime.lifecycle.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
  hasSameLifecycleInput,
  normalizeOptionalDir,
  normalizePreparedModelRuntimeInput,
  ownerKey,
  publishPreparedModelRuntimeOwnerBatch,
  publishModelRuntimeSnapshot,
  rebindInputToCommittedConfiguredOwner,
  resolveConfiguredOwnerPublication,
  readPublishedModelRuntimeSnapshot,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimePublicationOptions,
  type PreparedModelRuntimeRefreshOptions,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeReplacementGateId,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import {
  hasPreparedPluginPublicationForTest,
  releasePreparedPluginPublication,
} from "./prepared-model-runtime.plugin-lifetime.js";
import {
  notifyPreparedModelRuntimePublication,
  reportPreparedModelRuntimeAuthRefreshFailure,
  resetPreparedModelRuntimePublicationListenersForTest,
} from "./prepared-model-runtime.publication-events.js";
import { PreparedModelRuntimePublicationQueue } from "./prepared-model-runtime.publication-queue.js";
import {
  projectPublishedModelRuntimeOwner,
  retainPublishedModelRuntimeOwner,
} from "./prepared-model-runtime.published-owner.js";
import {
  refreshCommittedProviderCatalogs,
  createPreparedModelRuntimeCatalogRecovery,
  resolveSafeRefreshAgentIds,
  updateOwnersForScopedRefresh,
} from "./prepared-model-runtime.refresh-scope.js";
import { closeEphemeralPreparedModelRuntimeResources } from "./prepared-model-runtime.resources.js";
import {
  acquireRetainedAgentRuntimeCleanupRegistries,
  PreparedModelRuntimeOwnerRetention,
} from "./prepared-model-runtime.retention.js";
import { setPreparedModelRuntimeStartupStatus } from "./prepared-model-runtime.startup-status.js";
import { PreparedModelRuntimeStartup } from "./prepared-model-runtime.startup.js";
import type { PreparedModelRuntimeLeaseOptions } from "./prepared-model-runtime.types.js";
import { PreparedReplyDispatchPublicationOwner } from "./prepared-reply-dispatch-runtime.js";
export {
  PreparedModelRuntimeOwnerNotPublishedError,
  preparedModelRuntimeConfigsMatch,
} from "./prepared-model-runtime.owner.js";
export type { PreparedModelRuntimeReplacementGateId } from "./prepared-model-runtime.owner.js";
export { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
export type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLease,
  PreparedReplyDispatchRuntime,
  PreparedModelRuntimeSnapshot,
  PreparedModelRuntimeStores,
} from "./prepared-model-runtime.owner.js";
export type { PreparedModelCatalogRefreshOptions } from "./prepared-model-runtime.types.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");
// Match channel startup grace. Startup releases its foreground wait at this
// deadline; the completion chain continues to own acquisition and serialization.
const DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS = 120_000;
let modelRuntimeBuildTimeoutMs = DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS;

const owners = new Map<string, PreparedModelRuntimeOwner>();
const agentBuildCompletions = new Map<string, Promise<void>>();
const standaloneActivationTails = new Map<string, Promise<void>>();
const retainedDirectRunOwners = new PreparedModelRuntimeOwnerRetention(1);
const retainedGatewayRunOwners = new PreparedModelRuntimeOwnerRetention(8);
let gatewayLifecycleActive = false;
const publicationQueue = new PreparedModelRuntimePublicationQueue();
let refreshRequestEpoch = 0;
let refreshCancellation = new AbortController();
let pendingModelRuntimeReplacement: PreparedModelRuntimeReplacement | undefined;
const catalogGenerationRecovery = new PreparedModelCatalogGenerationRecoveryOwner();
const authPublication = new PreparedModelRuntimeAuthPublicationOwner();
const getBlockingReplacement = () =>
  pendingModelRuntimeReplacement?.degraded ? undefined : pendingModelRuntimeReplacement;

const replyDispatchPublication = new PreparedReplyDispatchPublicationOwner({
  isGatewayLifecycleActive: () => gatewayLifecycleActive,
  getPendingOwnerPublication: (agentId) =>
    resolveConfiguredOwnerPublication(owners, {
      agentId,
      agentDir: ".",
      config: {},
    }).pending,
  getPendingReplacement: () => getBlockingReplacement()?.promise,
});
export const loadPublishedGatewayReplyDispatchRuntime = replyDispatchPublication.load;

let releaseProcessLifetime: (() => void) | undefined;
function captureModelRuntimeLifetime(): () => void {
  const assertCurrent = capturePreparedModelRuntimeLifetime();
  if (!releaseProcessLifetime) {
    // Completed process teardown ends the previous refresh admission fence.
    refreshCancellation = new AbortController();
    releaseProcessLifetime = registerPreparedModelRuntimeClose(closeModelRuntime);
  }
  return assertCurrent;
}

/** Seal refresh admission and cancel acquisition after every Gateway fences admission. */
export function cancelPreparedModelRuntimeRefresh(): void {
  if (releaseProcessLifetime && refreshCancellation.signal.aborted) {
    return;
  }
  captureModelRuntimeLifetime();
  // Fence pending publications before cancellation can reenter a provider callback.
  refreshRequestEpoch += 1;
  refreshCancellation.abort(new Error("prepared model runtime acquisition stopped for shutdown"));
}

async function closeModelRuntime(error: Error): Promise<void> {
  refreshRequestEpoch += 1;
  authPublication.reset(error);
  pendingModelRuntimeReplacement?.reject(error);
  pendingModelRuntimeReplacement = undefined;
  setPreparedModelRuntimeStartupStatus(undefined);
  // The final generation owner observes failures after all build and caller joins.
  void closeEphemeralPreparedModelRuntimeResources().catch(() => {});
  const closingOwners = [...owners.values()];
  owners.clear();
  closingOwners.forEach(retirePreparedModelRuntimeGeneration);
  retainedDirectRunOwners.clear(owners);
  retainedGatewayRunOwners.clear(owners);
  gatewayLifecycleActive = false;
  replyDispatchPublication.clear();
  refreshCancellation.abort(error);
  const results = await Promise.allSettled([
    publicationQueue.settle(),
    ...agentBuildCompletions.values(),
    ...standaloneActivationTails.values(),
  ]);
  catalogGenerationRecovery.reset();
  closingOwners.forEach(releasePreparedPluginPublication);
  releaseProcessLifetime?.();
  releaseProcessLifetime = undefined;
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, "Prepared model work failed to close");
  }
}

/** Advances model-neutral config identity without rebuilding prepared generation artifacts. */
export function advancePreparedModelRuntimeConfig(config: OpenClawConfig): void {
  advancePreparedModelRuntimeOwnersConfig(owners.values(), config);
  replyDispatchPublication.advanceConfig(config);
}

/** Resolves a published owner or activates a standalone lifecycle owner. */
export async function loadPreparedModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot> {
  return await loadPreparedModelRuntimeOwner(rawInput, (_owner, snapshot) => snapshot);
}

/** Borrows the selected publication without changing its activation or retention policy. */
export async function acquirePublishedPreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeLease> {
  return await loadPreparedModelRuntimeOwner(rawInput, retainPublishedModelRuntimeOwner);
}

/** Retains the selected publication without activating an unpublished owner. */
export async function acquirePreparedModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeLease> {
  return await projectPublishedModelRuntimeOwner(
    rawInput,
    preparedModelRuntimeLeaseContext,
    retainPublishedModelRuntimeOwner,
  );
}

/** Retains existing execution owners, including switched-away models, without loading plugins. */
export async function acquireAgentRuntimeCleanupRegistries(agentDir: string) {
  return await acquireRetainedAgentRuntimeCleanupRegistries(
    normalizeOptionalDir(agentDir),
    preparedModelRuntimeLeaseContext,
  );
}

async function loadPreparedModelRuntimeOwner<T>(
  rawInput: PreparedModelRuntimeInput,
  project: (owner: PreparedModelRuntimeOwner, snapshot: PreparedModelRuntimeSnapshot) => T,
): Promise<T> {
  const assertLifetime = captureModelRuntimeLifetime();
  let input = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  for (;;) {
    assertLifetime();
    const replacement = getBlockingReplacement();
    if (replacement) {
      await replacement.promise;
      if (getBlockingReplacement()) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(owners, input);
      continue;
    }
    try {
      return await projectPublishedModelRuntimeOwner(
        input,
        preparedModelRuntimeLeaseContext,
        project,
      );
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
    }
    if (getBlockingReplacement()) {
      continue;
    }
    assertLifetime();
    const activated = await activateStandalonePreparedModelRuntime(input);
    if (getBlockingReplacement()) {
      continue;
    }
    if (!activated) {
      return await projectPublishedModelRuntimeOwner(
        input,
        preparedModelRuntimeLeaseContext,
        project,
      );
    }
    try {
      return await projectPublishedModelRuntimeOwner(
        input,
        preparedModelRuntimeLeaseContext,
        project,
      );
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
      // A concurrent publication boundary may retire the standalone owner between build and read.
      // Retry only after proving that no replacement gate owns the next generation.
    }
  }
}

/** Returns an already-published generation without starting discovery. */
export function getPreparedModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): PreparedModelRuntimeSnapshot | undefined {
  return getBlockingReplacement() ? undefined : readPublishedModelRuntimeSnapshot(owners, rawInput);
}

/** Publishes one owner from an explicit startup/activation lifecycle boundary. */
export async function publishPreparedModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
  options: PreparedModelRuntimePublicationOptions = {},
): Promise<PreparedModelRuntimeSnapshot> {
  captureModelRuntimeLifetime();
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const existing = owners.get(ownerKey(input));
  if (existing?.pending) {
    if (!options.force && hasSameLifecycleInput(existing.input, input)) {
      return await existing.pending;
    }
  } else {
    if (existing?.buildCompletion) {
      throw (
        existing.refreshError ??
        new Error(`prepared model runtime build is still settling for ${input.agentDir}`)
      );
    }
    if (
      existing?.snapshot &&
      !existing.needsRefresh &&
      !options.force &&
      hasSameLifecycleInput(existing.input, input)
    ) {
      return existing.snapshot;
    }
  }
  return await publishModelRuntimeSnapshot(
    input,
    owners,
    agentBuildCompletions,
    modelRuntimeBuildTimeoutMs,
    existing,
    options.provenance,
    options.catalogMode,
  );
}

/** Activates lifecycle publication for direct embedded runtimes without a gateway startup. */
export async function activateStandalonePreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
  options: Pick<PreparedModelRuntimePublicationOptions, "catalogMode"> = {},
): Promise<PreparedModelRuntimeSnapshot | undefined> {
  const assertLifetime = captureModelRuntimeLifetime();
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const key = ownerKey(input);
  const previous = standaloneActivationTails.get(key) ?? Promise.resolve();
  // One writer per owner key prevents conflicting config activations from alternately
  // superseding each other's generation while preserving each caller's requested snapshot.
  const activation = previous.then(
    async () => await activateStandalonePreparedModelRuntimeNow(input, assertLifetime, options),
  );
  const tail = activation.then(
    () => undefined,
    () => undefined,
  );
  standaloneActivationTails.set(key, tail);
  try {
    return await activation;
  } finally {
    if (standaloneActivationTails.get(key) === tail) {
      standaloneActivationTails.delete(key);
    }
  }
}

async function activateStandalonePreparedModelRuntimeNow(
  input: PreparedModelRuntimeInput,
  assertLifetime: () => void,
  options: Pick<PreparedModelRuntimePublicationOptions, "catalogMode">,
): Promise<PreparedModelRuntimeSnapshot | undefined> {
  for (;;) {
    assertLifetime();
    const overlapsConfiguredOwner = [...owners.values()].some(
      (owner) =>
        owner.provenance === "configured" &&
        owner.input.agentDir === input.agentDir &&
        (input.agentId === undefined || owner.input.agentId === input.agentId) &&
        (input.workspaceDir === undefined || owner.input.workspaceDir === input.workspaceDir),
    );
    if (gatewayLifecycleActive && (!input.readOnly || overlapsConfiguredOwner)) {
      // Gateway startup/reload owns configured identities. Isolated read-only drafts may publish
      // separately, but stale drafts must never replace an overlapping configured generation.
      return undefined;
    }
    try {
      return await publishPreparedModelRuntimeSnapshot(
        {
          ...input,
          preserveWorkspaceDirOnRefresh: input.workspaceDir !== undefined,
        },
        { ...options, provenance: "standalone" },
      );
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimePublicationSupersededError)) {
        throw error;
      }
      const replacement = pendingModelRuntimeReplacement;
      if (replacement) {
        await replacement.promise;
      }
    }
  }
}

const preparedModelRuntimeLeaseContext = {
  captureLifetime: captureModelRuntimeLifetime,
  owners,
  agentBuildCompletions,
  retainedDirectRunOwners,
  retainedGatewayRunOwners,
  getBuildTimeoutMs: () => modelRuntimeBuildTimeoutMs,
  getGatewayLifecycleActive: () => gatewayLifecycleActive,
  getPendingReplacement: getBlockingReplacement,
};

/** Acquires a run generation from configured facts; full catalog discovery is explicit. */
export async function acquireAgentRunPreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
  options: PreparedModelRuntimeLeaseOptions = {},
): Promise<PreparedModelRuntimeLease> {
  return await acquirePreparedModelRuntimeLeaseFromOwners(
    rawInput,
    "run",
    preparedModelRuntimeLeaseContext,
    { ...options, catalogMode: options.catalogMode ?? "static" },
  );
}

/** Acquires an exact read-only generation scoped to the returned lease. */
export async function acquireReadOnlyPreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
  options: PreparedModelRuntimeLeaseOptions = {},
): Promise<PreparedModelRuntimeLease> {
  return await acquirePreparedModelRuntimeLeaseFromOwners(
    { ...rawInput, readOnly: true },
    "ephemeral",
    preparedModelRuntimeLeaseContext,
    { ...options, catalogMode: options.catalogMode ?? "live" },
  );
}

/** Returns the snapshot published by the lifecycle owner. Request config cannot replace it. */
export async function prepareModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot> {
  return await projectPublishedModelRuntimeOwner(
    rawInput,
    preparedModelRuntimeLeaseContext,
    (_owner, snapshot) => snapshot,
  );
}

/** Initializes or refreshes inventory on catalog demand; turn admission remains static. */
export const refreshPreparedModelRuntimeCatalog = createPreparedModelRuntimeCatalogRefresh(owners);

/** Invalidates every published generation before config/plugin runtime replacement. */
export function markPreparedModelRuntimeSnapshotsStale(
  reason = "prepared model runtime owner is stale after config publication",
  options: {
    waitForReplacement?: boolean;
    preserveReplacementWait?: boolean;
    agentIds?: ReadonlySet<string>;
  } = {},
): PreparedModelRuntimeReplacementGateId | undefined {
  captureModelRuntimeLifetime();
  refreshCancellation.signal.throwIfAborted();
  const previousCancellation = refreshCancellation;
  refreshCancellation = new AbortController();
  setPreparedModelRuntimeStartupStatus(undefined);
  replyDispatchPublication.clear();
  if (options.waitForReplacement) {
    const superseded = pendingModelRuntimeReplacement;
    pendingModelRuntimeReplacement = createPreparedModelRuntimeReplacement();
    authPublication.adopt(pendingModelRuntimeReplacement.gateId);
    // Superseded readers retry against the newer replacement gate.
    superseded?.resolve();
  } else if (!options.preserveReplacementWait && pendingModelRuntimeReplacement) {
    const cancelled = pendingModelRuntimeReplacement;
    pendingModelRuntimeReplacement = undefined;
    cancelled.resolve();
  }
  refreshRequestEpoch += 1;
  const staleError = new Error(reason);
  updateOwnersForScopedRefresh(owners, options.agentIds, staleError, {
    retireStandalone: true,
    resetPluginGeneration: true,
  });
  // Fence epochs and admission before cancellation can reenter a plugin callback.
  previousCancellation.abort(new PreparedModelRuntimePublicationSupersededError(reason));
  const replacement = getBlockingReplacement();
  notifyPreparedModelRuntimePublication({
    phase: "invalidated",
    ...(replacement ? { replacement: replacement.promise } : {}),
  });
  if (!pendingModelRuntimeReplacement) {
    notifyPreparedModelRuntimePublication({ phase: "failed", error: staleError });
  }
  return pendingModelRuntimeReplacement?.gateId;
}

// oxfmt-ignore
export async function replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(
  snapshot: PreparedModelRuntimeSnapshot, identity?: readonly [owner: PreparedModelRuntimeOwner, generation: number],
) {
  // oxfmt-ignore
  return await catalogGenerationRecovery.replace(snapshot, {
      owners,
      agentBuildCompletions,
      buildTimeoutMs: modelRuntimeBuildTimeoutMs,
      getPendingReplacement: () => pendingModelRuntimeReplacement,
      setPendingReplacement: (replacement) => (pendingModelRuntimeReplacement = replacement),
      adoptAuthPublication: (replacement) => authPublication.adopt(replacement.gateId),
      commitReplacement: (replacement) => {
        authPublication.commitAdopted(replacement, owners, () => {
          replyDispatchPublication.replacePublished(owners.values());
          pendingModelRuntimeReplacement = undefined;
        });
        notifyPreparedModelRuntimePublication({ phase: "published" });
      },
      rejectAuthPublication: (replacement, error) =>
        authPublication.rejectAdopted(replacement.gateId, error),
      removeReplyDispatch: (agentIds) => replyDispatchPublication.remove(agentIds),
      enqueuePublication: (task) => publicationQueue.enqueue(task),
      drainPendingAuthMutations: (commit, required, error) => drainAuth(commit, required, error),
  }, identity);
}

/** Rejects readers waiting for a replacement when its owning reload cannot continue. */
export function rejectPendingPreparedModelRuntimeReplacement(
  gateId: PreparedModelRuntimeReplacementGateId | undefined,
  error: unknown,
): void {
  const replacement = pendingModelRuntimeReplacement;
  if (!replacement || !gateId || replacement.gateId !== gateId) {
    return;
  }
  pendingModelRuntimeReplacement = undefined;
  const replacementError = toStringifiedError(error);
  authPublication.rejectAdopted(replacement.gateId, replacementError);
  replacement.reject(replacementError);
  notifyPreparedModelRuntimePublication({ phase: "failed", error: replacementError });
}

export const recoverPreparedModelRuntimeCatalogWorker = createPreparedModelRuntimeCatalogRecovery(
  owners,
  refreshPreparedModelRuntimeSnapshots,
);

/** Serializes config/plugin publications so only the latest completed refresh retires owners. */
export function refreshPreparedModelRuntimeSnapshots(
  config: OpenClawConfig | (() => OpenClawConfig | Promise<OpenClawConfig>),
  options: PreparedModelRuntimeRefreshOptions = {},
): Promise<void> {
  if (options.isPublicationCurrent?.() === false) {
    return Promise.resolve();
  }
  const requestedScopedRefresh = options.agentIds !== undefined;
  const initialAgentIds =
    typeof config === "function" ? undefined : resolveSafeRefreshAgentIds(config, options, owners);
  const forceFullRefresh = requestedScopedRefresh && initialAgentIds === undefined;
  // Stale synchronously. Queued publication must never leave the prior generation request-visible.
  markPreparedModelRuntimeSnapshotsStale(undefined, {
    waitForReplacement: true,
    agentIds: initialAgentIds,
  });
  const requestEpoch = refreshRequestEpoch;
  const acquisitionSignal = refreshCancellation.signal;
  const replacement = pendingModelRuntimeReplacement;
  let publicationAgentIds = initialAgentIds;
  const isPublicationCurrent = () =>
    requestEpoch === refreshRequestEpoch && options.isPublicationCurrent?.() !== false;
  const startup =
    options.startup === true && options.catalogMode === "static" && replacement
      ? new PreparedModelRuntimeStartup({
          replacement,
          owners: () => owners.values(),
          isCurrent: () => pendingModelRuntimeReplacement === replacement && isPublicationCurrent(),
          timeoutMs: modelRuntimeBuildTimeoutMs,
          warn: (message) => log.warn(message),
          publish: (readyOwners) => {
            replyDispatchPublication.rebuild(readyOwners);
            notifyPreparedModelRuntimePublication({ phase: "published" });
          },
          onDegraded: (publish) => {
            authPublication.releaseAdopted(replacement.gateId);
            void publicationQueue
              .enqueue(async () => {
                if (isPublicationCurrent()) {
                  await drainAuth(publish);
                }
              })
              .catch((error: unknown) => log.warn(`startup auth refresh failed: ${String(error)}`));
          },
        })
      : undefined;
  const rejectReplacement = (error: Error) => {
    if (requestEpoch === refreshRequestEpoch) {
      // A lost external claim can leave partially built owners; fence them even without a successor.
      updateOwnersForScopedRefresh(owners, publicationAgentIds, error, {
        clearPending: true,
        resetPluginGeneration: true,
      });
    }
    rejectPendingPreparedModelRuntimeReplacement(replacement?.gateId, error);
  };
  const commitReplacement = () => {
    if (!replacement || pendingModelRuntimeReplacement !== replacement) {
      return;
    }
    if (!isPublicationCurrent()) {
      rejectReplacement(
        new PreparedModelRuntimePublicationSupersededError(
          "prepared model runtime publication was superseded",
        ),
      );
      return;
    }
    const adoptedAuthTransaction = authPublication.prepareAdoptedCommit(replacement.gateId);
    replyDispatchPublication.rebuild(owners.values());
    pendingModelRuntimeReplacement = undefined;
    startup?.complete();
    if (adoptedAuthTransaction) {
      authPublication.resolve(adoptedAuthTransaction, owners);
    }
    replacement.resolve();
    // Publication listeners may synchronously read the committed owner. Clear the lifecycle
    // gate before announcing availability so they cannot observe a false missing generation.
    notifyPreparedModelRuntimePublication({ phase: "published" });
    refreshCommittedProviderCatalogs(owners.values());
  };
  const publication = publicationQueue
    .enqueue(async () => {
      if (!isPublicationCurrent()) {
        return;
      }
      const currentConfig = typeof config === "function" ? await config() : config;
      if (!isPublicationCurrent()) {
        return;
      }
      publicationAgentIds = forceFullRefresh
        ? undefined
        : resolveSafeRefreshAgentIds(currentConfig, options, owners);
      retainedGatewayRunOwners.clear(owners);
      gatewayLifecycleActive ||= options.gatewayLifecycle === true;
      await refreshPreparedModelRuntimeSnapshotsNow(
        currentConfig,
        { ...options, agentIds: publicationAgentIds },
        {
          owners,
          agentBuildCompletions,
          gatewayLifecycleActive,
          isPublicationCurrent,
          buildTimeoutMs: modelRuntimeBuildTimeoutMs,
          progress: startup?.progress,
          acquisitionSignal,
        },
      );
      if (!isPublicationCurrent()) {
        return;
      }
      const drain = () =>
        drainAuth(
          // The final queue check, dispatch rebuild, and replacement resolution are one synchronous
          // commit. A mutation before it is adopted; a mutation after it starts a new auth transaction.
          commitReplacement,
        );
      if (replacement?.degraded) {
        await publicationQueue.enqueue(drain);
      } else {
        await drain();
      }
    }, startup?.release)
    .then(commitReplacement, (error: unknown) => {
      const refreshError = toStringifiedError(error);
      if (replacement?.degraded && isPublicationCurrent()) {
        startup?.update(true);
        if (pendingModelRuntimeReplacement === replacement) {
          pendingModelRuntimeReplacement = undefined;
        }
      } else {
        rejectReplacement(refreshError);
      }
      throw refreshError;
    });
  return publicationQueue.complete(publication, isPublicationCurrent, options, startup);
}

async function drainAuth(
  commit?: () => void,
  required?: PreparedModelRuntimeOwner,
  requiredError?: unknown,
): Promise<void> {
  await authPublication.drain({
    owners,
    publish: async (ownersToPublish, includeCredentialProviders, reuseGenerations) =>
      await publishPreparedModelRuntimeOwnerBatch({
        ownersToPublish,
        owners,
        agentBuildCompletions,
        buildTimeoutMs: modelRuntimeBuildTimeoutMs,
        ...(includeCredentialProviders ? { includeCredentialProviders: true } : {}),
        selectPluginGeneration: reuseGenerations ? (owner) => owner.pluginGeneration : undefined,
      }),
    publishOwners: (publishedOwners) => replyDispatchPublication.replace(publishedOwners),
    commit,
    onOwnerFailure: reportPreparedModelRuntimeAuthRefreshFailure,
    requiredError,
    requiredOwner: required,
  });
}

function invalidateForAuthMutation(event: PreparedModelRuntimeAuthMutation): void {
  const normalizedEvent = {
    ...event,
    agentDir: normalizeOptionalDir(event.agentDir),
  };
  const { invalidatedOwners, invalidatedConfiguredAgentIds } =
    invalidatePreparedModelRuntimeOwnersForAuthMutation(owners, normalizedEvent);
  if (invalidatedOwners.length === 0) {
    // A first owner reads the already-published auth snapshot while it builds. Replaying an earlier
    // mutation would immediately stale that initial generation even though no prior owner existed.
    return;
  }
  replyDispatchPublication.remove(invalidatedConfiguredAgentIds);
  const transaction = authPublication.enqueue(invalidatedOwners, normalizedEvent.profileSetChanged);
  if (getBlockingReplacement()) {
    // The active config transaction drains this event before its atomic dispatch commit. Retire
    // the superseded build gate; queuing another task would make this commit depend on future work.
    authPublication.adoptTransaction(transaction, getBlockingReplacement()!.gateId);
    notifyPreparedModelRuntimePublication({ phase: "invalidated" });
    return;
  }
  if (!authPublication.claimPublication(transaction)) {
    notifyPreparedModelRuntimePublication({ phase: "invalidated" });
    return;
  }
  const publication = publicationQueue.enqueue(async () => {
    // A pending replacement gate means a queued config publication owns the next generation:
    // it drains queued auth mutations against the new config and rebuilds/announces the
    // dispatch publication. Rebuilding here would revive stale owners with the old config or
    // throw on them, emitting a spurious failed/published event that wedges chat metadata.
    if (getBlockingReplacement()) {
      authPublication.adoptTransaction(transaction, getBlockingReplacement()!.gateId);
      return;
    }
    await drainAuth(() => {
      // Admission waits only for static publication; account discovery owns a separate lifetime.
      if (getBlockingReplacement()) {
        authPublication.adoptTransaction(transaction, getBlockingReplacement()!.gateId);
        return;
      }
      if (!authPublication.resolve(transaction, owners)) {
        return;
      }
      if (pendingModelRuntimeReplacement?.degraded || configuredOwnersAreRequestVisible(owners)) {
        notifyPreparedModelRuntimePublication({ phase: "published" });
        refreshCommittedProviderCatalogs(owners.values());
      }
    });
  });
  notifyPreparedModelRuntimePublication({ phase: "invalidated" });
  void publication.catch((error: unknown) => {
    if (!authPublication.isCurrent(transaction)) {
      return;
    }
    if (getBlockingReplacement()) {
      authPublication.adoptTransaction(transaction, getBlockingReplacement()!.gateId);
      return;
    }
    if (error instanceof PreparedModelRuntimePublicationSupersededError) {
      return;
    }
    const refreshError = toStringifiedError(error);
    authPublication.reject(transaction, refreshError);
    reportPreparedModelRuntimeAuthRefreshFailure(refreshError);
  });
}

registerRuntimeAuthProfileStoreMutationListener(invalidateForAuthMutation);
registerPreparedRuntimeAuthMaterializationPublisher(owners, notifyPreparedModelRuntimePublication);

async function resetPreparedModelRuntimeSnapshotsForTest(): Promise<void> {
  await closePreparedModelRuntimeSnapshots();
  resetPreparedModelRuntimePublicationListenersForTest();
  modelRuntimeBuildTimeoutMs = DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.preparedModelRuntimeTestApi")] =
    {
      resetPreparedModelRuntimeSnapshotsForTest,
      getPreparedModelRuntimeOwnerCountForTest: () => owners.size,
      hasPreparedPluginPublicationForTest,
      setModelRuntimeBuildTimeoutMsForTest: (timeoutMs: number) => {
        modelRuntimeBuildTimeoutMs = timeoutMs;
      },
    };
}
