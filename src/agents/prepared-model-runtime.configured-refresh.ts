import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { prepareModelPricingContext } from "../model-catalog/pricing.js";
import {
  captureRemoteModelCatalogStartupSnapshot,
  publishRemoteModelCatalogSnapshot,
  readRemoteModelCatalogUpdate,
  runOutsideRemoteModelCatalogSnapshot,
  withRemoteModelCatalogSnapshot,
  type ActiveRemoteModelCatalog,
  type RemoteCatalogPublicationResult,
} from "../model-catalog/remote-overlay.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  capturePreparedModelRuntimeGeneration,
  retirePreparedModelRuntimeGeneration,
} from "./prepared-model-runtime.lifecycle.js";
import {
  advancePreparedModelRuntimeOwnerConfig,
  preparedModelRuntimeConfigsMatch,
  ownerKey,
  prepareModelRuntimeOwner,
  publishPreparedModelRuntimeOwnerBatch,
} from "./prepared-model-runtime.owner.js";
import {
  discardPreparedPluginGeneration,
  releasePreparedPluginPublication,
} from "./prepared-model-runtime.plugin-lifetime.js";
import { notifyPreparedModelRuntimePublication } from "./prepared-model-runtime.publication-events.js";
import type { PreparedModelRuntimePublicationQueue } from "./prepared-model-runtime.publication-queue.js";
import {
  collectPreparedModelRuntimeInventories,
  isPreparedModelRuntimeOwnerInRefreshScope,
  listConfiguredRefreshInputs,
  updateOwnersForScopedRefresh,
} from "./prepared-model-runtime.refresh-scope.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeRefreshOptions,
} from "./prepared-model-runtime.types.js";
import type { PreparedReplyDispatchPublicationOwner } from "./prepared-reply-dispatch-runtime.js";

export type PreparedModelRuntimeCatalogPublicationHost = {
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  publicationQueue: PreparedModelRuntimePublicationQueue;
  replyDispatchPublication: PreparedReplyDispatchPublicationOwner;
  captureLifetime: () => () => void;
  getEpoch: () => number;
  getCancellationSignal: () => AbortSignal;
  getPendingReplacement: () => Promise<void> | undefined;
  getBuildTimeoutMs: () => number;
  pending?: {
    catalog: ActiveRemoteModelCatalog;
    controller: AbortController;
    completion: Promise<RemoteCatalogPublicationResult>;
    isCurrent: () => boolean;
  };
};

/** Advances model-neutral config identity without rebuilding prepared generation artifacts. */
export function advancePreparedModelRuntimeConfigNow(
  host: PreparedModelRuntimeCatalogPublicationHost,
  config: OpenClawConfig,
): void {
  const pending = host.pending;
  if (
    pending &&
    !pending.controller.signal.aborted &&
    captureRemoteModelCatalogStartupSnapshot() !== pending.catalog
  ) {
    pending.controller.abort(
      new PreparedModelRuntimePublicationSupersededError(
        "Config changed during remote catalog preparation",
      ),
    );
  }
  for (const owner of host.owners.values()) {
    // Read-only owners include the config hash in their map key and remain bound to their lease.
    if (!owner.input.readOnly) {
      advancePreparedModelRuntimeOwnerConfig(owner, config);
    }
  }
  host.replyDispatchPublication.advanceConfig(config);
}

/** Downloads become visible only after an independently prepared rows/pricing generation commits. */
export function applyRemoteModelCatalogUpdateNow(
  host: PreparedModelRuntimeCatalogPublicationHost,
  getConfig: () => OpenClawConfig,
  signal?: AbortSignal,
): Promise<RemoteCatalogPublicationResult> {
  signal?.throwIfAborted();
  const assertLifetime = host.captureLifetime();
  const completion: Promise<RemoteCatalogPublicationResult> = host.publicationQueue.track(
    runOutsideRemoteModelCatalogSnapshot(async (): Promise<RemoteCatalogPublicationResult> => {
      const config = getConfig();
      const catalog = await readRemoteModelCatalogUpdate(config);
      assertLifetime();
      if (!catalog) {
        return "unchanged";
      }
      // Join outside the queue: degraded startup still owns a queued final commit.
      const replacement = host.getPendingReplacement();
      if (replacement) {
        await replacement;
        assertLifetime();
      }
      let previous = captureRemoteModelCatalogStartupSnapshot();
      if (previous?.sourceUrl === catalog.sourceUrl) {
        if (previous.revision === catalog.revision) {
          return "unchanged";
        }
        if (previous.generatedAt > catalog.generatedAt) {
          return "superseded";
        }
      }
      const pending = host.pending;
      if (pending?.catalog.sourceUrl === catalog.sourceUrl) {
        if (pending.catalog.revision === catalog.revision && pending.isCurrent()) {
          return await pending.completion;
        }
        if (pending.catalog.generatedAt > catalog.generatedAt) {
          return "superseded";
        }
      }
      if (pending?.isCurrent()) {
        pending.controller.abort(
          new PreparedModelRuntimePublicationSupersededError("A newer remote catalog was accepted"),
        );
      }
      const controller = new AbortController();
      const epoch = host.getEpoch();
      const isCurrent = () =>
        !controller.signal.aborted &&
        host.pending?.controller === controller &&
        host.getEpoch() === epoch &&
        captureRemoteModelCatalogStartupSnapshot() === previous &&
        preparedModelRuntimeConfigsMatch(config, getConfig());
      host.pending = { catalog, controller, completion, isCurrent };
      try {
        const published = await withRemoteModelCatalogSnapshot(catalog, () =>
          publishPreparedModelRuntimeCatalogReplacement({
            owners: host.owners,
            agentBuildCompletions: host.agentBuildCompletions,
            buildTimeoutMs: host.getBuildTimeoutMs(),
            controller,
            signal: host.getCancellationSignal(),
            isPublicationCurrent: isCurrent,
            prepareCommit: (candidates) => {
              const commitDispatch = host.replyDispatchPublication.stage(candidates);
              return () => {
                if (!publishRemoteModelCatalogSnapshot(catalog, previous)) {
                  throw new PreparedModelRuntimePublicationSupersededError(
                    "Remote catalog publication lost its accepted predecessor",
                  );
                }
                previous = null;
                commitDispatch();
              };
            },
            commit: (publish) =>
              host.publicationQueue.enqueue(async () => {
                assertLifetime();
                publish();
              }),
          }),
        );
        if (published) {
          notifyPreparedModelRuntimePublication({ phase: "published" });
        }
        return published ? "published" : "superseded";
      } catch (error) {
        if (
          error instanceof PreparedModelRuntimePublicationSupersededError ||
          controller.signal.aborted ||
          host.getEpoch() !== epoch
        ) {
          return "superseded";
        }
        throw error;
      } finally {
        if (host.pending?.controller === controller) {
          host.pending = undefined;
        }
      }
    }),
  );
  return racePromiseWithAbortSignal(completion, signal);
}

/** Rebuilds active owners after config/plugin runtime publication. */
export async function refreshPreparedModelRuntimeSnapshotsNow(
  config: OpenClawConfig,
  options: PreparedModelRuntimeRefreshOptions,
  context: {
    owners: Map<string, PreparedModelRuntimeOwner>;
    agentBuildCompletions: Map<string, Promise<void>>;
    buildTimeoutMs: number;
    gatewayLifecycleActive: boolean;
    isPublicationCurrent: () => boolean;
    acquisitionSignal: AbortSignal;
    progress?: Parameters<typeof publishPreparedModelRuntimeOwnerBatch>[0]["progress"];
  },
): Promise<void> {
  const { owners, agentBuildCompletions, gatewayLifecycleActive, isPublicationCurrent, progress } =
    context;
  const catalogMode = options.catalogMode ?? "live";
  const staleError = new Error("prepared model runtime owner is stale after config publication");
  const inventories = collectPreparedModelRuntimeInventories(owners.values());
  updateOwnersForScopedRefresh(owners, options.agentIds, staleError, {
    retainedConfig: config,
  });
  const entries: Array<{ owner?: PreparedModelRuntimeOwner; input: PreparedModelRuntimeInput }> =
    [];
  const knownKeys = new Set<string>();
  for (const input of listConfiguredRefreshInputs(config, options, owners)) {
    if (options.agentIds && input.agentId && !options.agentIds.has(input.agentId)) {
      continue;
    }
    const key = ownerKey(input);
    if (knownKeys.has(key)) {
      continue;
    }
    knownKeys.add(key);
    const owner = owners.get(key);
    entries.push({ owner, input });
  }
  for (const [key, owner] of owners) {
    if (!isPreparedModelRuntimeOwnerInRefreshScope(owner, options.agentIds)) {
      continue;
    }
    if (!knownKeys.has(key) && (gatewayLifecycleActive || owner.provenance === "configured")) {
      owners.delete(key);
      retirePreparedModelRuntimeGeneration(owner);
      releasePreparedPluginPublication(owner);
    }
  }
  const candidates = entries.map(({ owner: existing, input }) => {
    // Dynamic and standalone owners have different lifetime contracts. A configured publication
    // must replace them so an older lease release cannot remove the committed generation.
    const owner = prepareModelRuntimeOwner(
      input,
      "configured",
      catalogMode,
      existing?.provenance === "configured" ? existing : undefined,
    );
    owner.catalogInventory = inventories.get(
      ownerKey({ ...input, runtimePluginSelections: undefined }),
    );
    return owner;
  });
  await publishPreparedModelRuntimeOwnerBatch({
    ownersToPublish: candidates,
    owners,
    agentBuildCompletions,
    buildTimeoutMs: progress ? undefined : context.buildTimeoutMs,
    isPublicationCurrent,
    // Config replacement is one transaction. Per-owner auth supersession may retire individual
    // candidates, while a newer config epoch stops every remaining build in this publication.
    isBuildCurrent: isPublicationCurrent,
    onBuildStats: options.onBuildStats,
    pluginMetadataSnapshot: options.pluginMetadataSnapshot,
    registerEntriesAfterBuildStart: true,
    progress,
    acquisitionSignal: context.acquisitionSignal,
  });
}

/** Builds privately; only the final serialized commit replaces request-visible owners. */
async function publishPreparedModelRuntimeCatalogReplacement(params: {
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  buildTimeoutMs: number;
  controller: AbortController;
  signal: AbortSignal;
  isPublicationCurrent: () => boolean;
  prepareCommit: (owners: readonly PreparedModelRuntimeOwner[]) => () => void;
  commit: (publish: () => void) => Promise<void>;
}): Promise<boolean> {
  const claims = [...params.owners.values()]
    .filter((owner) => owner.provenance === "configured")
    .map((owner) => ({ owner, generation: owner.generation, input: owner.input }));
  if (
    !claims.length ||
    claims.some(({ owner }) => !owner.snapshot || owner.needsRefresh || owner.pending !== undefined)
  ) {
    return false;
  }
  const controller = params.controller;
  let parentSignals = [
    params.signal,
    ...claims.map(({ owner }) => capturePreparedModelRuntimeGeneration(owner)),
  ];
  const abortPreparation = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        new PreparedModelRuntimePublicationSupersededError(
          "A captured model owner retired during remote catalog preparation",
        ),
      );
    }
  };
  const stopWatchingParents = () => {
    for (const signal of parentSignals) {
      signal.removeEventListener("abort", abortPreparation);
    }
    parentSignals = [];
  };
  for (const signal of parentSignals) {
    signal.addEventListener("abort", abortPreparation, { once: true });
  }
  if (parentSignals.some((signal) => signal.aborted)) {
    abortPreparation();
  }
  const staged = new Map<string, PreparedModelRuntimeOwner>();
  let committed = false;
  const isCurrent = () =>
    !controller.signal.aborted &&
    params.isPublicationCurrent() &&
    claims.every(
      ({ owner, generation, input }) =>
        params.owners.get(ownerKey(input)) === owner &&
        owner.generation === generation &&
        owner.input === input &&
        !owner.needsRefresh &&
        !owner.pending,
    );
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "remote catalog publication was superseded",
      );
    }
  };
  const candidates = claims.map(({ input, generation }) => {
    const candidate = prepareModelRuntimeOwner(input, "configured", "static");
    candidate.generation = generation;
    return candidate;
  });
  const retireCandidates = () => {
    for (const owner of candidates) {
      owner.generation += 1;
      retirePreparedModelRuntimeGeneration(owner);
    }
  };
  controller.signal.addEventListener("abort", retireCandidates, { once: true });
  try {
    assertCurrent();
    await publishPreparedModelRuntimeOwnerBatch({
      ownersToPublish: candidates,
      owners: staged,
      agentBuildCompletions: params.agentBuildCompletions,
      buildTimeoutMs: params.buildTimeoutMs,
      registerEntriesAfterBuildStart: true,
      acquisitionSignal: controller.signal,
      isPublicationCurrent: () => committed || isCurrent(),
      isOwnerRegistered: (key, owner) => (committed ? params.owners : staged).get(key) === owner,
      isOwnerPublished: (key, owner) => committed && params.owners.get(key) === owner,
    });
    for (const config of new Set(candidates.map((owner) => owner.input.config))) {
      await prepareModelPricingContext(config);
    }
    await params.commit(() => {
      assertCurrent();
      const commit = params.prepareCommit(candidates);
      assertCurrent();
      commit();
      for (const owner of candidates) {
        params.owners.set(ownerKey(owner.input), owner);
      }
      committed = true;
      stopWatchingParents();
      controller.signal.removeEventListener("abort", retireCandidates);
      // Existing leases retain their pair; other owners must rebuild before new admission.
      for (const owner of params.owners.values()) {
        if (owner.provenance !== "configured") {
          owner.needsRefresh = true;
        }
      }
      for (const { owner } of claims) {
        owner.generation += 1;
        retirePreparedModelRuntimeGeneration(owner);
        releasePreparedPluginPublication(owner);
      }
      claims.length = 0;
      staged.clear();
    });
    for (const owner of candidates) {
      void owner.snapshot?.loadFullModelCatalog?.({ refresh: true }).catch(() => undefined);
    }
    return true;
  } catch (error) {
    if (
      !committed &&
      !(error instanceof PreparedModelRuntimePublicationSupersededError) &&
      !isCurrent()
    ) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "Remote catalog preparation lost its captured owners",
        { cause: error },
      );
    }
    throw error;
  } finally {
    stopWatchingParents();
    controller.signal.removeEventListener("abort", retireCandidates);
    if (!committed) {
      retireCandidates();
      for (const owner of candidates) {
        releasePreparedPluginPublication(owner);
      }
      const discarded: Promise<void>[] = [];
      for (const owner of candidates) {
        if (owner.pluginGeneration) {
          discarded.push(discardPreparedPluginGeneration(owner.pluginGeneration));
        }
      }
      await Promise.all(discarded);
    }
  }
}
