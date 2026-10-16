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
import { prepareSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { retirePreparedModelRuntimeGeneration } from "./prepared-model-runtime.lifecycle.js";
import {
  advancePreparedModelRuntimeOwnerConfig,
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
  getCancellationSignal: () => AbortSignal;
  getPendingReplacement: () => Promise<void> | undefined;
  getBuildTimeoutMs: () => number;
  /** Same recovery configured publication installs; adopted owners replace those owners. */
  onPluginGenerationRetired: (owner: PreparedModelRuntimeOwner) => void;
  pending?: {
    catalog: ActiveRemoteModelCatalog;
    /** Ends the adoption: a newer catalog or shutdown supersedes it. */
    controller: AbortController;
    completion: Promise<RemoteCatalogPublicationResult>;
  };
};

/** Binds the prepared runtime's publication host to the catalog adoption operations. */
export function createRemoteCatalogPublication(host: PreparedModelRuntimeCatalogPublicationHost) {
  return {
    applyRemoteModelCatalogUpdate: applyRemoteModelCatalogUpdateNow.bind(null, host),
    advancePreparedModelRuntimeConfig: advancePreparedModelRuntimeConfigNow.bind(null, host),
    /** Runtime close ends a pending adoption, including preparation still awaiting I/O. */
    cancel: (reason: Error): void => {
      host.pending?.controller.abort(reason);
      host.pending = undefined;
    },
  };
}

/** Advances model-neutral config identity without rebuilding prepared generation artifacts. */
function advancePreparedModelRuntimeConfigNow(
  host: PreparedModelRuntimeCatalogPublicationHost,
  config: OpenClawConfig,
): void {
  for (const owner of host.owners.values()) {
    // Read-only owners include the config hash in their map key and remain bound to their lease.
    if (!owner.input.readOnly) {
      advancePreparedModelRuntimeOwnerConfig(owner, config);
    }
  }
  host.replyDispatchPublication.advanceConfig(config);
}

/** Downloads become visible only after an independently prepared rows/pricing generation commits. */
function applyRemoteModelCatalogUpdateNow(
  host: PreparedModelRuntimeCatalogPublicationHost,
  getConfig: () => OpenClawConfig,
  signal?: AbortSignal,
): Promise<RemoteCatalogPublicationResult> {
  signal?.throwIfAborted();
  const assertLifetime = host.captureLifetime();
  const completion: Promise<RemoteCatalogPublicationResult> = host.publicationQueue.track(
    runOutsideRemoteModelCatalogSnapshot(async (): Promise<RemoteCatalogPublicationResult> => {
      const config = getConfig();
      const update = await readRemoteModelCatalogUpdate(config);
      assertLifetime();
      // The next catalog check retries if an overlapping config publication wins.
      const replacement = update ? host.getPendingReplacement() : undefined;
      if (replacement) {
        await replacement;
        assertLifetime();
      }
      if (!update) {
        return "unchanged";
      }
      const catalog = update;
      const previous = captureRemoteModelCatalogStartupSnapshot();
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
        if (pending.catalog.revision === catalog.revision && !pending.controller.signal.aborted) {
          return await pending.completion;
        }
        if (pending.catalog.generatedAt > catalog.generatedAt) {
          return "superseded";
        }
      }
      pending?.controller.abort(
        new PreparedModelRuntimePublicationSupersededError("A newer remote catalog was accepted"),
      );
      const controller = new AbortController();
      const adoption = {
        catalog,
        controller,
        completion,
      };
      host.pending = adoption;
      try {
        if (
          !(await withRemoteModelCatalogSnapshot(catalog, () =>
            publishPreparedModelRuntimeCatalogReplacement(
              host,
              catalog,
              previous,
              controller.signal,
            ),
          ))
        ) {
          return "superseded";
        }
        notifyPreparedModelRuntimePublication({ phase: "published" });
        return "published";
      } catch (error) {
        if (
          error instanceof PreparedModelRuntimePublicationSupersededError ||
          controller.signal.aborted ||
          host.getCancellationSignal().aborted
        ) {
          return "superseded";
        }
        throw error;
      } finally {
        if (host.pending === adoption) {
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
    onPluginGenerationRetired: (owner: PreparedModelRuntimeOwner) => void;
    progress?: Parameters<typeof publishPreparedModelRuntimeOwnerBatch>[0]["progress"];
  },
): Promise<void> {
  await prepareSharedAuthStoreOwnership();
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
    owner.onPluginGenerationRetired = context.onPluginGenerationRetired.bind(context, owner);
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
async function publishPreparedModelRuntimeCatalogReplacement(
  host: PreparedModelRuntimeCatalogPublicationHost,
  catalog: ActiveRemoteModelCatalog,
  previous: ActiveRemoteModelCatalog | null,
  adoptionSignal: AbortSignal,
): Promise<boolean> {
  const claims = [...host.owners.values()]
    .filter((owner) => owner.provenance === "configured")
    .map((owner) => ({ owner, generation: owner.generation, input: owner.input }));
  if (
    !claims.length ||
    claims.some(({ owner }) => !owner.snapshot || owner.needsRefresh || owner.pending !== undefined)
  ) {
    return false;
  }
  const signal = AbortSignal.any([adoptionSignal, host.getCancellationSignal()]);
  const buildTimeoutMs = host.getBuildTimeoutMs();
  const staged = new Map<string, PreparedModelRuntimeOwner>();
  let committed = false;
  const candidates = claims.map(({ input, generation }) => {
    const candidate = prepareModelRuntimeOwner(input, "configured", "static");
    candidate.generation = generation;
    // Unpublished loan retirement is checked at commit; published owners use normal recovery.
    candidate.onPluginGenerationRetired = () => {
      if (committed) {
        host.onPluginGenerationRetired(candidate);
      }
    };
    return candidate;
  });
  const retireCandidates = () => {
    for (const owner of candidates) {
      owner.generation += 1;
      retirePreparedModelRuntimeGeneration(owner);
    }
  };
  signal.addEventListener("abort", retireCandidates, { once: true });
  try {
    await publishPreparedModelRuntimeOwnerBatch({
      ownersToPublish: candidates,
      owners: staged,
      agentBuildCompletions: host.agentBuildCompletions,
      buildTimeoutMs,
      registerEntriesAfterBuildStart: true,
      acquisitionSignal: signal,
      isPublicationCurrent: () => committed || !signal.aborted,
      isOwnerRegistered: (key, owner) => (committed ? host.owners : staged).get(key) === owner,
      isOwnerPublished: (key, owner) => committed && host.owners.get(key) === owner,
    });
    // Pricing preparation takes no signal; cancellation, shutdown and a stalled read must not
    // leave adoption pending, so it shares the owner build deadline.
    const pricingSignal = AbortSignal.any([signal, AbortSignal.timeout(buildTimeoutMs)]);
    for (const config of new Set(candidates.map((owner) => owner.input.config))) {
      await racePromiseWithAbortSignal(prepareModelPricingContext(config), pricingSignal);
    }
    // Readers keep the committed generation until each candidate has discovered its own rows.
    // A failed discovery publishes the candidate's static rows, never the previous catalog's.
    await racePromiseWithAbortSignal(
      Promise.allSettled(
        candidates.map(
          async (owner) =>
            await owner.snapshot?.loadFullModelCatalog?.({
              refresh: true,
              changedOnly: true,
              wait: true,
            }),
        ),
      ),
      signal,
    );
    await host.publicationQueue.enqueue(async () => {
      signal.throwIfAborted();
      // One effect check keeps auth refreshes and retired plugins from publishing stale authority.
      if (
        claims.some(
          ({ owner, generation, input }) =>
            host.owners.get(ownerKey(input)) !== owner ||
            owner.generation !== generation ||
            owner.needsRefresh ||
            owner.pending !== undefined,
        ) ||
        candidates.some((owner) => owner.needsRefresh || !owner.pluginGeneration)
      ) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "A remote catalog owner retired before publication",
        );
      }
      // Keep new-run policy current without rebuilding model-neutral catalog facts.
      for (const [index, candidate] of candidates.entries()) {
        advancePreparedModelRuntimeOwnerConfig(candidate, claims[index]!.owner.input.config);
      }
      const commitDispatch = host.replyDispatchPublication.stage(candidates);
      if (!publishRemoteModelCatalogSnapshot(catalog, previous)) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Remote catalog publication lost its accepted predecessor",
        );
      }
      commitDispatch();
      for (const owner of candidates) {
        host.owners.set(ownerKey(owner.input), owner);
      }
      committed = true;
      signal.removeEventListener("abort", retireCandidates);
      // Existing leases retain their pair; other owners must rebuild before new admission.
      for (const owner of host.owners.values()) {
        if (owner.provenance !== "configured") {
          owner.needsRefresh = true;
        }
      }
      for (const { owner } of claims) {
        owner.generation += 1;
        retirePreparedModelRuntimeGeneration(owner);
        releasePreparedPluginPublication(owner);
      }
      staged.clear();
    });
    return true;
  } finally {
    signal.removeEventListener("abort", retireCandidates);
    if (!committed) {
      retireCandidates();
      await Promise.all(
        candidates.map(async (owner) => {
          releasePreparedPluginPublication(owner);
          if (owner.pluginGeneration) {
            await discardPreparedPluginGeneration(owner.pluginGeneration);
          }
        }),
      );
    }
  }
}
