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

const CATALOG_GENERATION_RECOVERY_COOLDOWN_MS = 5_000;

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

function invalidateCatalogOwner(
  owner: PreparedModelRuntimeOwner,
  dependencies: RecoveryDependencies,
  staleError: Error,
): void {
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
}

export class PreparedModelCatalogGenerationRecoveryOwner {
  #recoveries = new WeakMap<PreparedModelRuntimeOwner, Promise<void>>();
  #retryAfterByAgentDir = new Map<string, number>();

  reset(): void {
    this.#recoveries = new WeakMap();
    this.#retryAfterByAgentDir.clear();
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

    const now = Date.now();
    const retryAfter = this.#retryAfterByAgentDir.get(owner.input.agentDir) ?? 0;
    const staleError = new Error(
      `prepared model runtime catalog generation was invalid for ${owner.input.agentDir}`,
    );
    if (retryAfter > now) {
      invalidateCatalogOwner(owner, dependencies, staleError);
      owner.catalogRecovery = {
        error: staleError,
        scheduledAttempted: false,
        retryAfter,
      };
      return false;
    }
    this.#retryAfterByAgentDir.set(
      owner.input.agentDir,
      now + CATALOG_GENERATION_RECOVERY_COOLDOWN_MS,
    );

    const replacement = createPreparedModelRuntimeReplacement();
    const isReplacementCurrent = () => dependencies.getPendingReplacement() === replacement;
    dependencies.setPendingReplacement(replacement);
    dependencies.adoptAuthPublication(replacement);
    invalidateCatalogOwner(owner, dependencies, staleError);

    let recoveryError: Error | undefined;
    const recovery = dependencies.enqueuePublication(async () => {
      if (!isReplacementCurrent() || dependencies.owners.get(ownerKey(owner.input)) !== owner) {
        return;
      }
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
      if (
        dependencies.owners.get(ownerKey(owner.input)) === owner &&
        owner.needsRefresh &&
        owner.refreshError === refreshError
      ) {
        owner.catalogRecovery = {
          error: refreshError,
          scheduledAttempted: false,
          retryAfter: 0,
        };
      }
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
