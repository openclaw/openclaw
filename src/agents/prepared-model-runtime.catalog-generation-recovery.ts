import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import {
  createPreparedModelRuntimeReplacement,
  retirePreparedModelRuntimeGeneration,
} from "./prepared-model-runtime.lifecycle.js";
import {
  ownerKey,
  publishPreparedModelRuntimeOwnerBatch,
  resolveConfiguredOwner,
  resolvePreparedModelRuntimeOwnerBySnapshot,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import { releasePreparedPluginPublication } from "./prepared-model-runtime.plugin-lifetime.js";
import { notifyPreparedModelRuntimePublication } from "./prepared-model-runtime.publication-events.js";

type RecoveryDependencies = {
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  buildTimeoutMs: number;
  getPendingReplacement: () => PreparedModelRuntimeReplacement | undefined;
  setPendingReplacement: (replacement: PreparedModelRuntimeReplacement | undefined) => void;
  adoptAuthPublication: (replacement: PreparedModelRuntimeReplacement) => void;
  commitReplacement: (replacement: PreparedModelRuntimeReplacement) => void;
  rejectAuthPublication: (replacement: PreparedModelRuntimeReplacement, error: Error) => void;
  removeReplyDispatch: (agentIds: ReadonlySet<string>) => void;
  enqueuePublication: (task: () => Promise<void>) => Promise<void>;
  drainPendingAuthMutations: (
    commit: () => void,
    requiredOwner: PreparedModelRuntimeOwner,
    requiredError?: unknown,
  ) => Promise<void>;
};

function wasSnapshotSuperseded(
  snapshot: PreparedModelRuntimeSnapshot,
  dependencies: RecoveryDependencies,
): boolean {
  const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
  if (
    owner &&
    (dependencies.owners.get(ownerKey(owner.input)) !== owner || owner.snapshot !== snapshot)
  ) {
    return true;
  }
  const replacement = resolveConfiguredOwner(dependencies.owners, snapshot);
  return Boolean(replacement?.snapshot && replacement.snapshot !== snapshot);
}

export class PreparedModelCatalogGenerationRecoveryOwner {
  #recoveries = new WeakMap<PreparedModelRuntimeOwner, Promise<void>>();

  reset(): void {
    this.#recoveries = new WeakMap();
  }

  async replace(
    snapshot: PreparedModelRuntimeSnapshot,
    dependencies: RecoveryDependencies,
    identity?: readonly [owner: PreparedModelRuntimeOwner, generation: number],
  ): Promise<boolean> {
    const owner = identity?.[0] ?? resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
    if (!owner) {
      return wasSnapshotSuperseded(snapshot, dependencies);
    }
    return await this.replaceOwnedSnapshot(
      {
        owner,
        generation: identity?.[1] ?? owner.generation,
        snapshot,
        preserveCapturedGeneration: identity !== undefined,
      },
      dependencies,
    );
  }

  async replaceOwnedSnapshot(
    identity: {
      owner: PreparedModelRuntimeOwner;
      generation: number;
      snapshot: PreparedModelRuntimeSnapshot;
      preserveCapturedGeneration: boolean;
    },
    dependencies: RecoveryDependencies,
  ): Promise<boolean> {
    const { owner, generation, snapshot, preserveCapturedGeneration } = identity;
    if (
      dependencies.owners.get(ownerKey(owner.input)) !== owner ||
      owner.provenance !== "configured" ||
      owner.generation !== generation
    ) {
      return false;
    }
    const activeRecovery = this.#recoveries.get(owner);
    if (activeRecovery) {
      await activeRecovery;
      return wasSnapshotSuperseded(snapshot, dependencies);
    }
    let pendingReplacement = dependencies.getPendingReplacement();
    while (pendingReplacement) {
      try {
        await pendingReplacement.promise;
      } catch (error) {
        if (!preserveCapturedGeneration) {
          throw error;
        }
      }
      if (
        !preserveCapturedGeneration ||
        dependencies.owners.get(ownerKey(owner.input)) !== owner ||
        owner.generation !== generation
      ) {
        return wasSnapshotSuperseded(snapshot, dependencies);
      }
      const newerReplacement = dependencies.getPendingReplacement();
      if (!newerReplacement || newerReplacement === pendingReplacement) {
        break;
      }
      pendingReplacement = newerReplacement;
    }

    const replacement = createPreparedModelRuntimeReplacement();
    const isReplacementCurrent = () => dependencies.getPendingReplacement() === replacement;
    dependencies.setPendingReplacement(replacement);
    dependencies.adoptAuthPublication(replacement);
    const staleError = new Error(
      `prepared model runtime catalog generation was invalid for ${owner.input.agentDir}`,
    );
    owner.generation += 1;
    retirePreparedModelRuntimeGeneration(owner);
    owner.needsRefresh = true;
    owner.refreshError = staleError;
    owner.pluginGeneration = undefined;
    releasePreparedPluginPublication(owner);
    if (owner.input.agentId) {
      dependencies.removeReplyDispatch(new Set([owner.input.agentId]));
    }
    notifyPreparedModelRuntimePublication({ phase: "invalidated" });

    const recovery = dependencies.enqueuePublication(async () => {
      if (!isReplacementCurrent() || dependencies.owners.get(ownerKey(owner.input)) !== owner) {
        return;
      }
      let recoveryError: Error | undefined;
      try {
        await publishPreparedModelRuntimeOwnerBatch({
          ownersToPublish: [owner],
          owners: dependencies.owners,
          agentBuildCompletions: dependencies.agentBuildCompletions,
          buildTimeoutMs: dependencies.buildTimeoutMs,
          isPublicationCurrent: isReplacementCurrent,
          isBuildCurrent: isReplacementCurrent,
        });
      } catch (error) {
        if (!isReplacementCurrent()) {
          return;
        }
        recoveryError = toStringifiedError(error);
      }
      if (!isReplacementCurrent()) {
        return;
      }
      await dependencies.drainPendingAuthMutations(
        () => {
          if (isReplacementCurrent()) {
            dependencies.commitReplacement(replacement);
          }
        },
        owner,
        recoveryError,
      );
    });
    this.#recoveries.set(owner, recovery);
    try {
      await recovery;
    } catch (error) {
      const refreshError = toStringifiedError(error);
      if (!isReplacementCurrent()) {
        await dependencies.getPendingReplacement()?.promise;
        return wasSnapshotSuperseded(snapshot, dependencies);
      }
      dependencies.setPendingReplacement(undefined);
      dependencies.rejectAuthPublication(replacement, refreshError);
      replacement.resolve();
      notifyPreparedModelRuntimePublication({ phase: "failed", error: refreshError });
      throw refreshError;
    } finally {
      if (this.#recoveries.get(owner) === recovery) {
        this.#recoveries.delete(owner);
      }
    }
    if (!isReplacementCurrent()) {
      await dependencies.getPendingReplacement()?.promise;
    }
    return wasSnapshotSuperseded(snapshot, dependencies);
  }
}
