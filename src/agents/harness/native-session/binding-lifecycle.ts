import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { AgentHarnessSessionDeletionMutation } from "../types.js";
import {
  createNativeSessionBindingLeases,
  type NativeSessionBindingLeaseConfig,
  type NativeSessionBindingLeaseOptions,
  type NativeSessionBindingRecord,
  type NativeSessionBindingStateStore,
} from "./binding-leases.js";

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
  let mutationsDrained: (() => void)[] = [];

  const waitForMutations = async (): Promise<void> => {
    if (activeMutations === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      mutationsDrained.push(resolve);
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
        mutationsDrained = [];
        for (const resolve of drained) {
          resolve();
        }
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
    const deleteIf = state.deleteIf?.bind(state);
    if (!deleteIf) {
      throw new Error(options.errors.conditionalDeletionRequired);
    }
    return await withMutation(async () => {
      deletion.assertCurrent();
      if (state.lookup(key) === undefined) {
        let active = true;
        try {
          return await run(undefined, {
            commit() {
              deletion.assertCurrent();
              if (!active || state.lookup(key) !== undefined) {
                throw new Error(options.errors.deletionChanged);
              }
            },
            rollback() {},
          });
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
            return await run(stored, {
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
            });
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
