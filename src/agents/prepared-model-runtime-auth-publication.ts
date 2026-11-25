import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { runOutsidePluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { resolveLegacyInheritedAuthDir } from "./legacy-inherited-auth-dir.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import {
  capturePreparedModelRuntimeRefreshError,
  isPreparedModelRuntimePluginLifecycleFailure,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";
import { retirePreparedModelRuntimeGeneration } from "./prepared-model-runtime.lifecycle.js";
import {
  normalizeOptionalDir,
  normalizePreparedModelRuntimeInput,
  ownerKey,
  prepareModelRuntimeOwner,
  resolveConfiguredOwner,
} from "./prepared-model-runtime.owner.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeReplacementGateId,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

export type PreparedModelRuntimeAuthMutation = {
  agentDir?: string;
  affectsInheritedStores: boolean;
  profileSetChanged: boolean;
  availabilityOnly?: boolean;
};

type PreparedModelRuntimeAuthTransaction = {
  adoptedBy?: PreparedModelRuntimeReplacementGateId;
  ownerGates: Map<
    PreparedModelRuntimeOwner,
    Deferred<PreparedModelRuntimeSnapshot> & { retries?: number }
  >;
  publicationQueued: boolean;
  profileSetChanged: boolean;
};

function partitionAuthMutationOwners(
  mutations: readonly (readonly PreparedModelRuntimeOwner[])[],
): PreparedModelRuntimeOwner[][] {
  // Overlapping owner identities share one atomic failure boundary. Independent components
  // retain FIFO order so one scoped credential failure cannot poison an unrelated owner.
  const components: Set<PreparedModelRuntimeOwner>[] = [];
  for (const invalidatedOwners of mutations) {
    const target = new Set(invalidatedOwners);
    let insertAt = components.length;
    for (let index = components.length - 1; index >= 0; index -= 1) {
      if (![...target].some((owner) => components[index]!.has(owner))) {
        continue;
      }
      insertAt = index;
      for (const owner of components[index]!) {
        target.add(owner);
      }
      components.splice(index, 1);
    }
    components.splice(insertAt, 0, target);
  }
  return components.map((component) => Array.from(component));
}

export class PreparedModelRuntimeAuthPublicationOwner {
  readonly #events: (readonly PreparedModelRuntimeOwner[])[] = [];
  #transaction: PreparedModelRuntimeAuthTransaction | undefined;
  #drainTail: Promise<void> = Promise.resolve();

  get hasPendingPublication(): boolean {
    return this.#transaction !== undefined;
  }

  enqueue(
    invalidatedOwners: readonly PreparedModelRuntimeOwner[],
    profileSetChanged = false,
  ): PreparedModelRuntimeAuthTransaction {
    this.#events.push([...invalidatedOwners]);
    const transaction =
      this.#transaction ??
      (this.#transaction = {
        ownerGates: new Map(),
        publicationQueued: false,
        profileSetChanged: false,
      });
    transaction.profileSetChanged ||= profileSetChanged;
    for (const owner of invalidatedOwners) {
      let gate = transaction.ownerGates.get(owner);
      if (!gate) {
        gate = createDeferredCore<PreparedModelRuntimeSnapshot>();
        transaction.ownerGates.set(owner, gate);
        void gate.promise.catch(() => undefined);
      }
      owner.pending = gate.promise;
    }
    return transaction;
  }

  claimPublication(transaction: PreparedModelRuntimeAuthTransaction): boolean {
    if (transaction.publicationQueued) {
      return false;
    }
    transaction.publicationQueued = true;
    return true;
  }

  isCurrent(transaction: PreparedModelRuntimeAuthTransaction): boolean {
    return this.#transaction === transaction;
  }

  adopt(gateId: PreparedModelRuntimeReplacementGateId): void {
    if (this.#transaction) {
      this.#transaction.adoptedBy = gateId;
    }
  }

  adoptTransaction(
    transaction: PreparedModelRuntimeAuthTransaction,
    gateId: PreparedModelRuntimeReplacementGateId,
  ): void {
    if (this.#transaction === transaction) {
      transaction.adoptedBy = gateId;
    }
  }

  prepareAdoptedCommit(
    gateId: PreparedModelRuntimeReplacementGateId,
  ): PreparedModelRuntimeAuthTransaction | undefined {
    const transaction = this.#transaction;
    if (transaction?.adoptedBy !== gateId) {
      return undefined;
    }
    this.clearOwnerGates(transaction);
    return transaction;
  }

  releaseAdopted(gateId: PreparedModelRuntimeReplacementGateId): void {
    if (this.#transaction?.adoptedBy === gateId) {
      this.#transaction.adoptedBy = undefined;
    }
  }

  resolve(
    transaction: PreparedModelRuntimeAuthTransaction,
    owners: Map<string, PreparedModelRuntimeOwner>,
  ): boolean {
    if (this.#transaction !== transaction) {
      return false;
    }
    if (!transaction.adoptedBy && transaction.ownerGates.size > 0) {
      return false;
    }
    this.#transaction = undefined;
    this.clearOwnerGates(transaction);
    for (const [owner, gate] of transaction.ownerGates) {
      const published =
        owners.get(ownerKey(owner.input)) ?? resolveConfiguredOwner(owners, owner.input);
      if (published?.snapshot && !published.needsRefresh && !published.pending) {
        gate.resolve(published.snapshot);
      } else {
        gate.reject(
          new PreparedModelRuntimePublicationSupersededError(
            `prepared model runtime publication was superseded for ${owner.input.agentDir}`,
          ),
        );
      }
    }
    return true;
  }

  settleComponent(
    transaction: PreparedModelRuntimeAuthTransaction,
    componentOwners: readonly PreparedModelRuntimeOwner[],
    owners: Map<string, PreparedModelRuntimeOwner>,
    publishOwners: (owners: readonly PreparedModelRuntimeOwner[]) => void,
  ): void {
    if (this.#transaction !== transaction || transaction.adoptedBy) {
      return;
    }
    const queuedOwners = new Set(this.#events.flat());
    const unsettled = componentOwners.flatMap((owner) => {
      const gate = transaction.ownerGates.get(owner);
      return gate && !queuedOwners.has(owner) ? [{ owner, gate }] : [];
    });
    const completed = unsettled.flatMap(({ owner, gate }) => {
      const published =
        owners.get(ownerKey(owner.input)) ?? resolveConfiguredOwner(owners, owner.input);
      return published?.snapshot &&
        !published.needsRefresh &&
        (!published.pending || published.pending === gate.promise)
        ? [{ owner, gate, published, snapshot: published.snapshot }]
        : [];
    });
    // Dispatch projection must become visible before exact-gate waiters resume.
    for (const { owner, gate, published } of completed) {
      if (owner.pending === gate.promise) {
        owner.pending = undefined;
      }
      if (published.pending === gate.promise) {
        published.pending = undefined;
      }
    }
    try {
      if (completed.length > 0) {
        publishOwners(completed.map(({ published }) => published));
      }
    } catch (error) {
      for (const { owner, gate } of completed) {
        if (transaction.ownerGates.get(owner) === gate && owner.pending === undefined) {
          owner.pending = gate.promise;
        }
      }
      throw error;
    }
    for (const { owner, gate, snapshot } of completed) {
      transaction.ownerGates.delete(owner);
      gate.resolve(snapshot);
    }
    this.rejectComponentOwners(
      transaction,
      componentOwners,
      new PreparedModelRuntimePublicationSupersededError(
        "prepared model runtime auth publication owner was superseded",
      ),
    );
  }

  reject(transaction: PreparedModelRuntimeAuthTransaction, error: Error): void {
    if (this.#transaction === transaction) {
      this.#transaction = undefined;
    }
    this.clearOwnerGates(transaction);
    for (const gate of transaction.ownerGates.values()) {
      gate.reject(error);
    }
  }

  rejectAdopted(gateId: PreparedModelRuntimeReplacementGateId, error: Error): void {
    if (this.#transaction?.adoptedBy === gateId) {
      this.reject(this.#transaction, error);
    }
  }

  async drain(params: {
    owners: Map<string, PreparedModelRuntimeOwner>;
    publish: (
      owners: PreparedModelRuntimeOwner[],
      includeCredentialProviders: boolean,
      reusePluginGenerations: boolean,
    ) => Promise<void>;
    publishOwners: (owners: readonly PreparedModelRuntimeOwner[]) => void;
    commit?: () => void;
    onOwnerFailure?: (error: unknown) => void;
  }): Promise<void> {
    const pending = this.#drainTail.then(() => this.drainNow(params));
    this.#drainTail = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
  }

  private async drainNow(
    params: Parameters<PreparedModelRuntimeAuthPublicationOwner["drain"]>[0],
  ): Promise<void> {
    while (this.#events.length > 0) {
      const components = partitionAuthMutationOwners(this.#events.splice(0));
      for (const componentOwners of components) {
        const owners = componentOwners.filter(
          (owner) => params.owners.get(ownerKey(owner.input)) === owner,
        );
        const reusedOwners = new Set(
          owners.filter((owner) => owner.pluginGeneration !== undefined),
        );
        const gates = owners.flatMap((owner) => this.#transaction?.ownerGates.get(owner) ?? []);
        const retries = Math.max(0, ...gates.map((gate) => gate.retries ?? 0));
        const retrying = retries > 0;
        for (const gate of gates) {
          gate.retries = retries;
        }
        try {
          if (owners.length > 0) {
            const publish = async () => {
              try {
                await params.publish(
                  owners,
                  this.#transaction?.profileSetChanged === true,
                  !retrying,
                );
              } catch (error) {
                const transaction = this.#transaction;
                if (
                  !(error instanceof PreparedModelRuntimePublicationSupersededError) ||
                  !transaction ||
                  transaction.adoptedBy
                ) {
                  throw error;
                }
                const authGates = new Set(
                  [...transaction.ownerGates.values()].map((gate) => gate.promise),
                );
                const replacements = componentOwners.flatMap((owner) => {
                  const published =
                    params.owners.get(ownerKey(owner.input)) ??
                    resolveConfiguredOwner(params.owners, owner.input);
                  const gate = transaction.ownerGates.get(owner);
                  if (!published || !gate) {
                    return [];
                  }
                  if (published.pending && !authGates.has(published.pending)) {
                    return [published.pending];
                  }
                  return published.snapshot && !published.needsRefresh
                    ? [Promise.resolve(published.snapshot)]
                    : [];
                });
                if (replacements.length !== componentOwners.length) {
                  throw error;
                }
                // Join one current publication; do not spend another generation retry or
                // wait on our own auth gates. Settlement rechecks the registered owners.
                await Promise.all(replacements);
              }
            };
            await (retrying
              ? runOutsidePreparedModelRuntimePluginGenerationScope(() =>
                  runOutsidePluginRuntimeGenerationScope(publish),
                )
              : publish());
          }
          const transaction = this.#transaction;
          if (transaction) {
            this.settleComponent(transaction, componentOwners, params.owners, params.publishOwners);
          }
        } catch (error) {
          if (this.#transaction?.adoptedBy) {
            if (
              error instanceof PreparedModelRuntimePublicationSupersededError &&
              this.#events.some((event) => event.some((owner) => componentOwners.includes(owner)))
            ) {
              // The queued mutation owns the next build; preserve its entire atomic component.
              this.#events.push(componentOwners);
              continue;
            }
            // The replacement transaction exclusively settles adopted gates from its own result.
            throw error;
          }
          const transaction = this.#transaction;
          const currentOwners = owners.filter(
            (owner) =>
              owner.pending !== undefined &&
              params.owners.get(ownerKey(owner.input)) === owner &&
              transaction?.ownerGates.get(owner)?.promise === owner.pending,
          );
          const superseded = error instanceof PreparedModelRuntimePublicationSupersededError;
          if (
            transaction &&
            retries < (superseded ? 2 : 1) &&
            isPreparedModelRuntimePluginLifecycleFailure(error) &&
            currentOwners.some((owner) => superseded || reusedOwners.has(owner))
          ) {
            for (const owner of currentOwners) {
              transaction.ownerGates.get(owner)!.retries = retries + 1;
            }
            // Preserve the exact gates and atomic component, including superseded members.
            this.#events.push(componentOwners);
            continue;
          }
          const Failure = superseded ? PreparedModelRuntimePublicationSupersededError : Error;
          const failure = retrying
            ? new Failure(
                `Auth-triggered model runtime refresh failed after ${retries} fresh-generation ${retries === 1 ? "retry" : "retries"}: ${toStringifiedError(error).message}${superseded ? "; retry the request" : ""}`,
                { cause: error },
              )
            : error;
          if (
            transaction &&
            this.rejectComponentOwners(transaction, componentOwners, failure, true) > 0
          ) {
            params.onOwnerFailure?.(failure);
          }
        }
      }
    }
    // The queue check and commit share one synchronous section so no mutation can be orphaned.
    params.commit?.();
  }

  reset(error: Error): void {
    if (this.#transaction) {
      this.reject(this.#transaction, error);
    }
    this.#events.length = 0;
  }

  private clearOwnerGates(transaction: PreparedModelRuntimeAuthTransaction): void {
    for (const [owner, gate] of transaction.ownerGates) {
      if (owner.pending === gate.promise) {
        owner.pending = undefined;
      }
    }
  }

  private rejectComponentOwners(
    transaction: PreparedModelRuntimeAuthTransaction,
    componentOwners: readonly PreparedModelRuntimeOwner[],
    error: unknown,
    recordRefreshError = false,
  ): number {
    const queuedOwners = new Set(this.#events.flat());
    let rejected = 0;
    for (const owner of componentOwners) {
      if (queuedOwners.has(owner)) {
        continue;
      }
      const gate = transaction.ownerGates.get(owner);
      if (!gate) {
        continue;
      }
      if (owner.pending === gate.promise) {
        owner.pending = undefined;
        if (recordRefreshError) {
          owner.refreshError = capturePreparedModelRuntimeRefreshError(error);
          owner.needsRefresh = true;
          if (owner.provenance === "configured") {
            owner.catalogRecovery ??= {
              error: owner.refreshError,
              scheduledAttempted: false,
              retryAfter: 0,
            };
            owner.catalogRecovery.error = owner.refreshError;
          }
        }
      }
      transaction.ownerGates.delete(owner);
      gate.reject(error);
      rejected += 1;
    }
    return rejected;
  }
}

export function invalidatePreparedModelRuntimeOwnersForAuthMutation(
  owners: Map<string, PreparedModelRuntimeOwner>,
  event: PreparedModelRuntimeAuthMutation,
): {
  invalidatedOwners: PreparedModelRuntimeOwner[];
  invalidatedConfiguredAgentIds: Set<string>;
} {
  // Availability reads use the auth snapshot owner's current usage view. Rebuilding here
  // would retire otherwise-current plugins and supersede concurrent credential publications.
  if (event.availabilityOnly) {
    return { invalidatedOwners: [], invalidatedConfiguredAgentIds: new Set() };
  }
  const agentDir = normalizeOptionalDir(event.agentDir);
  const staleError = capturePreparedModelRuntimeRefreshError(
    new Error("prepared model runtime owner is stale after auth mutation"),
  );
  const invalidatedOwners: PreparedModelRuntimeOwner[] = [];
  const invalidatedConfiguredAgentIds = new Set<string>();
  for (const owner of owners.values()) {
    if (
      // An initial active build will read current credentials; failed owners still need recovery.
      (!owner.snapshot &&
        owner.buildCompletion &&
        !owner.authCaptureStarted &&
        !owner.refreshError &&
        owner.input.inheritedAuthDir ===
          normalizeOptionalDir(
            resolveLegacyInheritedAuthDir(owner.input.config, owner.input.env),
          )) ||
      (!event.affectsInheritedStores &&
        owner.input.agentDir !== agentDir &&
        owner.input.inheritedAuthDir !== agentDir)
    ) {
      continue;
    }
    invalidatedOwners.push(owner);
    owner.generation += 1;
    retirePreparedModelRuntimeGeneration(owner);
    owner.needsRefresh = true;
    owner.refreshError = staleError;
    if (event.profileSetChanged) {
      owner.catalogStale = true;
    }
    if (owner.provenance === "configured" && owner.input.agentId) {
      invalidatedConfiguredAgentIds.add(owner.input.agentId);
    }
  }
  // Rebind before queueing: readers must find the pending owner while an older build settles.
  for (const owner of invalidatedOwners) {
    if (owner.provenance !== "configured") {
      continue;
    }
    const inheritedAuthDir = normalizeOptionalDir(
      resolveLegacyInheritedAuthDir(owner.input.config, owner.input.env),
    );
    if (owner.input.inheritedAuthDir === inheritedAuthDir) {
      continue;
    }
    const previousKey = ownerKey(owner.input);
    const input = normalizePreparedModelRuntimeInput({ ...owner.input, inheritedAuthDir });
    prepareModelRuntimeOwner(input, "configured", owner.catalogMode, owner);
    owners.delete(previousKey);
    const key = ownerKey(input);
    const previous = owners.get(key);
    owners.set(key, owner);
    if (previous && previous !== owner) {
      retirePreparedModelRuntimeGeneration(previous);
    }
  }
  return { invalidatedOwners, invalidatedConfiguredAgentIds };
}
