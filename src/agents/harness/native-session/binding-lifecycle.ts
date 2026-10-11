import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { resolveRuntimeFacadeModuleLocation } from "../../../plugin-sdk/facade-resolution-shared.js";
import type { PluginStateNativeBindingCodec } from "../../../plugin-state/plugin-state-native-binding.types.js";
import { capturePluginStateNativeBindingStore } from "../../../plugin-state/plugin-state-store.native-binding.js";
import { validateKey } from "../../../plugin-state/plugin-state-store.validation.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { AgentHarnessSessionDeletionMutation } from "../types.js";
import {
  createNativeSessionBindingLeases,
  type NativeSessionBindingLeaseConfig,
  type NativeSessionBindingLeaseOptions,
  type NativeSessionBindingRecord,
  type NativeSessionBindingStateStore,
} from "./binding-leases.js";
import {
  bindNativeSessionDeletionParticipant,
  type NativeSessionDeletionParticipant,
} from "./deletion-participant.js";

/** Shared binding coordination; backend callbacks retain native ownership and retention policy. */
export function createNativeSessionBindingLifecycle<TRecord extends NativeSessionBindingRecord>(
  state: NativeSessionBindingStateStore<TRecord>,
  options: NativeSessionBindingLifecycleOptions<TRecord>,
) {
  const leases = createNativeSessionBindingLeases(state, options);
  const exclusiveContext = new AsyncLocalStorage<boolean>();
  let activeMutations = 0;
  let pendingExclusiveOperations = 0;
  let exclusiveTail = Promise.resolve();
  // The exclusive tail admits only one drain waiter at a time.
  let mutationsDrained: (() => void) | undefined;

  const waitForMutations = async (): Promise<void> => {
    if (activeMutations === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      mutationsDrained = resolve;
    });
  };

  const withMutation = async <TResult>(run: () => Promise<TResult>): Promise<TResult> => {
    if (exclusiveContext.getStore() === true) {
      return await run();
    }
    // Exclusive native operations require one stable ownership snapshot. Late
    // callers cannot attach bindings after that operation has begun.
    if (pendingExclusiveOperations > 0) {
      throw new Error(options.errors.mutationBlocked);
    }
    activeMutations += 1;
    try {
      return await run();
    } finally {
      activeMutations -= 1;
      if (activeMutations === 0) {
        const drained = mutationsDrained;
        mutationsDrained = undefined;
        drained?.();
      }
    }
  };

  const withExclusiveMutationFence = async <TResult>(
    run: () => Promise<TResult>,
  ): Promise<TResult> => {
    pendingExclusiveOperations += 1;
    const operation = exclusiveTail.then(async () => {
      await waitForMutations();
      return await exclusiveContext.run(true, run);
    });
    exclusiveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await operation;
    } finally {
      pendingExclusiveOperations -= 1;
    }
  };

  const withDeletion = async <TResult>(
    key: string,
    deletion: NativeSessionBindingDeletionOptions<TRecord>,
    run: (
      current: TRecord | undefined,
      mutation: AgentHarnessSessionDeletionMutation,
    ) => Promise<TResult>,
  ): Promise<TResult> => {
    leases.assertSettled(key);
    const store = options.workerCodec
      ? capturePluginStateNativeBindingStore(
          state.withCurrent({ assertCurrent: deletion.assertCurrent }),
        )
      : undefined;
    const workerCodec =
      (options.workerCodec === "codex" || options.workerCodec === "agentsapi") &&
      store?.options.pluginId === options.workerCodec
        ? options.workerCodec
        : undefined;
    const source =
      workerCodec && store
        ? captureOpenClawStateWorkerContext({ env: store.options.env })
        : undefined;
    const codecOwner = workerCodec
      ? resolveRuntimeFacadeModuleLocation({
          dirName: workerCodec,
          artifactBasename: "native-session-binding-api.js",
        })
      : undefined;
    if (codecOwner === null) {
      throw new Error(`Native session binding codec is unavailable: ${workerCodec}`);
    }
    const bindParticipant = (
      mutation: AgentHarnessSessionDeletionMutation,
      value?: Omit<TRecord, "lease">,
      owner?: ReturnType<typeof leases.owner>,
    ) => {
      if (!store || !source || !workerCodec || !source.admission.identity.key.startsWith("file:")) {
        return mutation;
      }
      const custody = new Set<object>();
      const participant: NativeSessionDeletionParticipant = {
        binding: {
          codec: workerCodec,
          codecSource: codecOwner
            ? {
                rootDir: codecOwner.boundaryRoot,
                source: codecOwner.modulePath,
                origin: codecOwner.origin ?? "global",
              }
            : undefined,
          pluginId: store.options.pluginId,
          namespace: store.options.namespace,
          key: validateKey(key, "delete"),
          maxEntries: store.options.maxEntries,
          overflowPolicy: store.options.overflowPolicy,
          ttlMs: store.options.defaultTtlMs,
          staleMs: options.lease.staleMs,
          deletionChanged: options.errors.deletionChanged,
          rollbackChanged: options.errors.rollbackChanged,
          predicate: owner ? { kind: "leased", token: owner.token, value } : { kind: "absent" },
        },
        source: source.admission.identity,
        assertCurrent() {
          source.admission.assertCurrent();
          source.maintenanceScope?.assertAdmission();
          store.assertCurrent?.();
          deletion.assertCurrent();
          if (owner?.failure || owner?.phase === "closed") {
            throw owner.failure ?? options.errors.lostLease(key);
          }
        },
        renewalPending: () => owner?.renewalPending() ?? false,
        joinRenewal: async () => {
          await owner?.joinRenewal();
        },
        quiesce: () => owner?.quiesce(),
        retain: (custodian) => {
          custody.add(custodian);
        },
        unknown: false,
        settle(outcome, error) {
          if (outcome === "unknown") {
            participant.unknown = true;
            const failure = error ?? new Error("Native binding settlement is unknown");
            if (owner) {
              owner.block(failure, participant);
            } else {
              leases.block(key, failure, participant);
            }
          } else if (owner) {
            owner.phase = outcome === "committed" ? "deleted" : "held";
          }
        },
      };
      return bindNativeSessionDeletionParticipant(mutation, participant);
    };
    const deleteIf = state.deleteIf?.bind(state);
    if (!deleteIf) {
      throw new Error(options.errors.conditionalDeletionRequired);
    }
    return await withMutation(async () => {
      deletion.assertCurrent();
      if (state.lookup(key) === undefined) {
        let active = true;
        try {
          const mutation: AgentHarnessSessionDeletionMutation = {
            commit() {
              deletion.assertCurrent();
              if (!active || state.lookup(key) !== undefined) {
                throw new Error(options.errors.deletionChanged);
              }
            },
            rollback() {},
          };
          return await run(undefined, bindParticipant(mutation));
        } finally {
          active = false;
        }
      }
      return await leases.withLease(
        key,
        async () => {
          const owner = leases.owner(key)!;
          const stored = options.readRecord(state.lookup(key));
          deletion.assertRecordCurrent(stored);
          if (!stored) {
            throw new Error(options.errors.deletionChanged);
          }
          const { lease: _lease, ...expectedValue } = stored;
          let deleted: TRecord | undefined;
          let active = true;
          const assertActive = () => {
            deletion.assertCurrent();
            if (!active || owner.phase === "closed" || owner.failure) {
              throw owner.failure ?? options.errors.lostLease(key);
            }
          };
          try {
            const mutation: AgentHarnessSessionDeletionMutation = {
              commit() {
                assertActive();
                if (deleted) {
                  return;
                }
                let removed: TRecord | undefined;
                const applied = deleteIf(key, (raw) => {
                  const parsed = options.readRecord(raw);
                  const { lease, ...value } = parsed ?? {};
                  if (
                    lease?.token !== owner.token ||
                    lease.expiresAt <= Date.now() ||
                    !isDeepStrictEqual(value, expectedValue)
                  ) {
                    return false;
                  }
                  // Renewal can finish while synchronous deletion awaits admission.
                  // Compare ownership and payload in this transaction, retaining the
                  // exact removed row for rollback rather than a pre-wait snapshot.
                  removed = raw;
                  return true;
                });
                if (!applied || !removed) {
                  throw new Error(options.errors.deletionChanged);
                }
                deleted = removed;
                // The host commits synchronously after removal; heartbeat
                // renewal must not recreate a row during artifact publication.
                owner.phase = "deleted";
              },
              rollback() {
                assertActive();
                if (!deleted) {
                  return;
                }
                const restored = {
                  ...deleted,
                  lease: {
                    token: owner.token,
                    expiresAt: Date.now() + options.lease.staleMs,
                  },
                };
                if (!state.registerIfAbsent(key, restored)) {
                  throw new Error(options.errors.rollbackChanged);
                }
                deleted = undefined;
                owner.phase = "held";
              },
            };
            return await run(stored, bindParticipant(mutation, expectedValue, owner));
          } finally {
            active = false;
          }
        },
        deletion,
      );
    });
  };

  return {
    captureLeaseAssertion: leases.captureLeaseAssertion,
    transact: leases.transact,
    withLease: leases.withLease,
    hasLease: leases.hasLease,
    withMutation,
    withExclusiveMutationFence,
    withDeletion,
  };
}

type NativeSessionBindingLifecycleOptions<TRecord extends NativeSessionBindingRecord> = Omit<
  NativeSessionBindingLeaseConfig<TRecord>,
  "errors"
> & {
  /** Only bundled, audited codecs qualify for the worker storage participant. */
  workerCodec?: PluginStateNativeBindingCodec;
  errors: NativeSessionBindingLeaseConfig<TRecord>["errors"] & {
    mutationBlocked: string;
    conditionalDeletionRequired: string;
    deletionChanged: string;
    rollbackChanged: string;
  };
};

type NativeSessionBindingDeletionOptions<TRecord extends NativeSessionBindingRecord> =
  NativeSessionBindingLeaseOptions<TRecord> & {
    assertCurrent: () => void;
    assertRecordCurrent: (current: TRecord | undefined) => void;
  };

export type {
  NativeSessionBindingLeaseOptions,
  NativeSessionBindingStateStore,
} from "./binding-leases.js";
