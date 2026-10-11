import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import { assertPreparedModelRuntimeAdmissionCanWait } from "./prepared-model-runtime-admission.js";
import { readCapturedPreparedModelRuntimeCatalog } from "./prepared-model-runtime.capture.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import type {
  PreparedModelRuntimeLease,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeSnapshot,
  PreparedReplyDispatchRuntime,
} from "./prepared-model-runtime.types.js";

const EMPTY_REPLY_DISPATCH_PUBLICATION: readonly PreparedReplyDispatchRuntime[] = Object.freeze([]);

function createReplyDispatchRuntime(
  runtimeOwner: PreparedModelRuntimeOwner,
): PreparedReplyDispatchRuntime {
  const snapshot = runtimeOwner.snapshot!;
  const owner = resolvePublishedModelCatalogOwner(snapshot);
  const pluginGeneration = runtimeOwner.pluginGeneration;
  const inboundPluginRegistry = pluginGeneration?.inboundPluginRegistry;
  if (!pluginGeneration || !inboundPluginRegistry) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared inbound plugin registry was not published for ${snapshot.agentDir}`,
    );
  }
  return Object.freeze({
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    config: owner.config,
    modelCatalog: owner.modelCatalog,
    readFullModelCatalog: snapshot.readFullModelCatalog,
    inboundPluginRegistry,
    pluginGeneration,
  });
}

function buildReplyDispatchPublication(
  owners: Iterable<PreparedModelRuntimeOwner>,
): readonly PreparedReplyDispatchRuntime[] {
  const runtimes = [...owners]
    .filter((owner) => owner.provenance === "configured")
    .map((owner) => {
      if (!owner.snapshot || owner.needsRefresh || owner.pending) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared reply dispatch runtime owner was not published for ${owner.input.agentId ?? owner.input.agentDir}`,
        );
      }
      return createReplyDispatchRuntime(owner);
    })
    .toSorted((left, right) => left.agentId.localeCompare(right.agentId));
  if (new Set(runtimes.map((runtime) => runtime.agentId)).size !== runtimes.length) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      "prepared reply dispatch runtime publication contains duplicate configured agents",
    );
  }
  return Object.freeze(runtimes);
}

type PreparedReplyDispatchLoadParams = {
  agentId: string;
  abortSignal?: AbortSignal;
  demand?: "interactive" | "scheduled";
  /** Transfers the captured generation to a request preparing execution from these facts. */
  onRuntimeLease?: (lease: PreparedModelRuntimeLease) => void;
};

type PreparedReplyDispatchPublicationHost = Readonly<{
  retainOwner: (
    owner: PreparedModelRuntimeOwner,
    snapshot: PreparedModelRuntimeSnapshot,
  ) => PreparedModelRuntimeLease;
  isGatewayLifecycleActive: () => boolean;
  getConfiguredOwner: (agentId: string) => PreparedModelRuntimeOwner | undefined;
  getPendingReplacement: () => Promise<void> | undefined;
  isStartupPending: () => boolean;
  ensureReady: (params: PreparedReplyDispatchLoadParams) => Promise<void>;
}>;

/** Reads an immutable dispatch generation after the lifecycle's demand preparation. */
export class PreparedReplyDispatchPublicationOwner {
  #publication = EMPTY_REPLY_DISPATCH_PUBLICATION;
  #changed = createDeferredCore();

  constructor(private readonly host: PreparedReplyDispatchPublicationHost) {}

  #publish(publication: readonly PreparedReplyDispatchRuntime[]): void {
    this.#publication = publication;
    const changed = this.#changed;
    this.#changed = createDeferredCore();
    changed.resolve();
  }

  clear(): void {
    this.#publish(EMPTY_REPLY_DISPATCH_PUBLICATION);
  }

  advanceConfig(config: OpenClawConfig): void {
    this.#publish(
      Object.freeze(this.#publication.map((runtime) => Object.freeze({ ...runtime, config }))),
    );
  }

  rebuild(owners: Iterable<PreparedModelRuntimeOwner>): void {
    this.#publish(
      this.host.isGatewayLifecycleActive()
        ? buildReplyDispatchPublication(owners)
        : EMPTY_REPLY_DISPATCH_PUBLICATION,
    );
  }

  stage(owners: Iterable<PreparedModelRuntimeOwner>): () => void {
    const publication = this.host.isGatewayLifecycleActive()
      ? buildReplyDispatchPublication(owners)
      : EMPTY_REPLY_DISPATCH_PUBLICATION;
    return () => {
      this.#publish(publication);
    };
  }

  remove(agentIds: ReadonlySet<string>): void {
    if (agentIds.size > 0) {
      this.#publish(
        Object.freeze(this.#publication.filter((runtime) => !agentIds.has(runtime.agentId))),
      );
    }
  }

  replace(owners: readonly PreparedModelRuntimeOwner[]): void {
    const replacements = buildReplyDispatchPublication(owners);
    const agentIds = new Set(replacements.map((runtime) => runtime.agentId));
    this.#publish(
      Object.freeze(
        [
          ...this.#publication.filter((runtime) => !agentIds.has(runtime.agentId)),
          ...replacements,
        ].toSorted((left, right) => left.agentId.localeCompare(right.agentId)),
      ),
    );
  }

  readonly load = async (
    params: PreparedReplyDispatchLoadParams,
  ): Promise<PreparedReplyDispatchRuntime | undefined> => {
    const { agentId, abortSignal, onRuntimeLease } = params;
    let demandPrepared = false;
    for (;;) {
      if (abortSignal?.aborted) {
        throw createAbortError("Prepared reply dispatch admission aborted", {
          cause: abortSignal.reason,
        });
      }
      if (!this.host.isGatewayLifecycleActive()) {
        return undefined;
      }
      const replacement = this.host.getPendingReplacement();
      const pendingOwner = replacement ? undefined : this.host.getConfiguredOwner(agentId);
      if (replacement) {
        assertPreparedModelRuntimeAdmissionCanWait();
      } else if (pendingOwner?.pending) {
        assertPreparedModelRuntimeAdmissionCanWait(pendingOwner);
      }
      if (!demandPrepared) {
        // Demand can join recovery, so preserve admission before that first wait.
        await this.host.ensureReady(params);
        demandPrepared = true;
        continue;
      }
      if (replacement) {
        await racePromiseWithAbortSignal(replacement, abortSignal);
        continue;
      }
      if (pendingOwner?.pending) {
        await racePromiseWithAbortSignal(pendingOwner.pending, abortSignal);
        continue;
      }
      const runtime = this.#publication.find((candidate) => candidate.agentId === agentId);
      if (!runtime) {
        if (this.host.isStartupPending()) {
          assertPreparedModelRuntimeAdmissionCanWait();
          await racePromiseWithAbortSignal(this.#changed.promise, abortSignal);
          continue;
        }
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared reply dispatch runtime owner was not published for ${agentId}`,
        );
      }
      if (onRuntimeLease) {
        if (
          !pendingOwner?.snapshot ||
          pendingOwner.needsRefresh ||
          pendingOwner.pluginGeneration !== runtime.pluginGeneration
        ) {
          throw new PreparedModelRuntimeOwnerNotPublishedError(
            `prepared reply dispatch runtime owner was not published for ${agentId}`,
          );
        }
        // Retain before the projection crosses an await: catalog adoption may retire
        // its publication while the caller is still preparing the first run.
        const lease = this.host.retainOwner(pendingOwner, pendingOwner.snapshot);
        try {
          onRuntimeLease(lease);
          const catalog = readCapturedPreparedModelRuntimeCatalog(lease.snapshot);
          return Object.freeze({ ...runtime, readFullModelCatalog: () => catalog });
        } catch (error) {
          await lease[Symbol.asyncDispose]();
          throw error;
        }
      }
      return runtime;
    }
  };
}
