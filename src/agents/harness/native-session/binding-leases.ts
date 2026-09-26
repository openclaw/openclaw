import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "../../../plugin-state/plugin-state-store.js";

/** Serializes native binding changes across processes without owning backend policy. */
export function createNativeSessionBindingLeases<TRecord extends NativeSessionBindingRecord>(
  state: NativeSessionBindingStateStore<TRecord>,
  options: NativeSessionBindingLeaseConfig<TRecord>,
) {
  if (!state.withCurrent) {
    throw new Error(options.errors.atomicUpdatesRequired);
  }
  const context = new AsyncLocalStorage<Map<string, NativeSessionBindingLeaseOwner>>();

  // Prepare data outside SQLite; the worker compares the complete observed row
  // and carries this action's authority through transaction and commit admission.
  const update = async (
    key: string,
    prepare: (raw: TRecord | undefined) => {
      next?: TRecord;
      ttlMs?: number;
      assertCurrent?: () => void;
    },
    assertCurrent?: () => void,
  ): Promise<boolean> => {
    let assertPreparedCurrent: (() => void) | undefined;
    const store = state.withCurrent({
      assertCurrent: () => {
        assertCurrent?.();
        assertPreparedCurrent?.();
      },
    });
    let observed = await store.observe(key);
    while (true) {
      const prepared = prepare(observed.value);
      assertPreparedCurrent = prepared.assertCurrent;
      const outcome = await store.compareAndApply(
        key,
        observed.comparison,
        prepared.next === undefined
          ? { operation: "update", action: "keep" }
          : {
              operation: "update",
              action: "set",
              value: prepared.next,
              ...(prepared.ttlMs === undefined ? {} : { ttlMs: prepared.ttlMs }),
            },
      );
      // A thrown or uncertain write is never replayed. Only comparison refusal
      // proves that this prepared mutation did not execute.
      if (outcome.status !== "conflict") {
        return prepared.next !== undefined;
      }
      assertPreparedCurrent = undefined;
      observed = outcome.current;
    }
  };

  const transact = async <TResult>(
    key: string,
    apply: (
      current: TRecord | undefined,
      leaseToken?: string,
    ) => { next?: TRecord; result: TResult },
    ttlMs?: number,
    assertCurrent?: () => void,
  ): Promise<TResult> => {
    const deadline = Date.now() + options.lease.waitMs;
    while (true) {
      let busy = false;
      let leaseLost = false;
      let result!: TResult;
      const owner = context.getStore()?.get(key);
      if (owner && owner.phase !== "held") {
        throw options.errors.lostLease(key);
      }
      if (owner?.failure) {
        throw owner.failure;
      }
      const ownedToken = owner?.token;
      const assertOwnerCurrent = () => {
        assertCurrent?.();
        owner?.assertCurrent?.();
        if (owner && (owner.phase !== "held" || owner.failure)) {
          throw owner.failure ?? options.errors.lostLease(key);
        }
      };
      assertOwnerCurrent();
      await update(
        key,
        (raw) => {
          busy = false;
          leaseLost = false;
          const current = readRecord(key, raw);
          const lease = current?.lease;
          const now = Date.now();
          if (ownedToken && (!lease || lease.token !== ownedToken || lease.expiresAt <= now)) {
            leaseLost = true;
            return {};
          }
          if (lease && lease.token !== ownedToken && lease.expiresAt > now) {
            busy = true;
            return {};
          }
          const applied = apply(current, ownedToken);
          const nextLease = applied.next?.lease;
          result = applied.result;
          return {
            next: applied.next,
            ttlMs,
            assertCurrent: () => {
              // Row comparison cannot detect elapsed time. Fence owned or newly
              // written leases, while allowing adoption to retain expired metadata.
              if (
                (ownedToken && lease!.expiresAt <= Date.now()) ||
                (nextLease &&
                  (nextLease.token !== lease?.token || nextLease.expiresAt !== lease?.expiresAt) &&
                  nextLease.expiresAt <= Date.now())
              ) {
                const failure = options.errors.lostLease(key);
                if (owner) {
                  owner.failure = failure;
                }
                throw failure;
              }
            },
          };
        },
        assertOwnerCurrent,
      );
      if (leaseLost) {
        const failure = options.errors.lostLease(key);
        if (owner) {
          owner.failure = failure;
        }
        throw failure;
      }
      if (!busy) {
        return result;
      }
      if (Date.now() >= deadline) {
        throw options.errors.leaseTimeout(key);
      }
      await sleep(options.lease.retryIntervalMs);
    }
  };

  const withLease = async <TResult>(
    key: string,
    run: () => Promise<TResult>,
    acquisition: NativeSessionBindingLeaseOptions<TRecord>,
  ): Promise<TResult> => {
    acquisition.assertCurrent?.();
    const owned = context.getStore();
    const existing = owned?.get(key);
    if (existing) {
      if (existing.phase !== "held") {
        throw options.errors.lostLease(key);
      }
      const failureBeforeRun = existing.failure;
      if (failureBeforeRun) {
        throw failureBeforeRun;
      }
      const result = await run();
      acquisition.assertCurrent?.();
      const failureAfterRun = existing.failure;
      if (failureAfterRun) {
        throw failureAfterRun;
      }
      return result;
    }
    const token = randomUUID();
    const acquired = await transact(
      key,
      (current) => {
        const next = acquisition.prepareLease(current, {
          token,
          expiresAt: Date.now() + options.lease.staleMs,
        });
        return { result: next !== undefined, next };
      },
      undefined,
      acquisition.assertCurrent,
    );
    acquisition.assertCurrent?.();
    if (!acquired) {
      throw options.errors.acquisitionRejected(key);
    }
    const owner: NativeSessionBindingLeaseOwner = {
      token,
      phase: "held",
      assertCurrent: acquisition.assertCurrent,
    };
    const nested = new Map(owned);
    nested.set(key, owner);
    // Exact-token renewal keeps bounded native requests serialized while a
    // replaced owner remains fenced, even when the request outlives one lease.
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (!renewal) {
        renewal = renew(key, owner).finally(() => {
          renewal = undefined;
        });
      }
    }, options.lease.renewIntervalMs);
    heartbeat.unref();
    try {
      const result = await context.run(nested, run);
      clearInterval(heartbeat);
      await renewal;
      acquisition.assertCurrent?.();
      if (owner.failure) {
        throw owner.failure;
      }
      return result;
    } finally {
      clearInterval(heartbeat);
      owner.phase = "closed";
      // A queued renewal must settle before release reads its final row. Its
      // admission guard also refuses after deletion or owner closure.
      await renewal;
      acquisition.assertCurrent?.();
      try {
        await update(
          key,
          (raw) => {
            const stored = readRecord(key, raw);
            if (stored?.lease?.token !== token) {
              return {};
            }
            const { lease: _lease, ...released } = stored;
            return {
              next: readRecord(key, released),
              ttlMs: options.releaseTtlMs(key, stored),
            };
          },
          acquisition.assertCurrent,
        );
      } catch (error) {
        acquisition.assertCurrent?.();
        // Crashed or unauthorized owners leave their bounded lease to expire.
        options.onReleaseFailure?.(key, error);
      }
    }
  };

  const readRecord = (key: string, raw: unknown) => {
    const current = options.readRecord(raw);
    if (raw !== undefined && !current) {
      throw options.errors.invalidRow(key);
    }
    return current;
  };

  const renew = async (key: string, owner: NativeSessionBindingLeaseOwner): Promise<void> => {
    if (owner.failure || owner.phase !== "held") {
      return;
    }
    try {
      const stored = await update(
        key,
        (raw) => {
          const current = readRecord(key, raw);
          const lease = current?.lease;
          const now = Date.now();
          if (!current || !lease || lease.token !== owner.token || lease.expiresAt <= now) {
            return {};
          }
          return {
            next: {
              ...current,
              lease: { token: owner.token, expiresAt: now + options.lease.staleMs },
            },
            assertCurrent: () => {
              if (lease.expiresAt <= Date.now()) {
                throw options.errors.lostLease(key);
              }
            },
          };
        },
        () => {
          owner.assertCurrent?.();
          if (owner.phase !== "held" || owner.failure) {
            throw owner.failure ?? options.errors.lostLease(key);
          }
        },
      );
      if (!stored && owner.phase === "held") {
        owner.failure = options.errors.lostLease(key);
      }
    } catch (error) {
      if (owner.phase === "held") {
        owner.failure = options.errors.lostLease(key, error);
      }
    }
  };

  const captureLeaseAssertion = (key: string): (() => void) => {
    const owner = context.getStore()?.get(key);
    const assertCurrent = () => {
      if (!owner || owner.phase !== "held") {
        throw options.errors.lostLease(key);
      }
      const lease = readRecord(key, state.lookup(key))?.lease;
      if (!lease || lease.token !== owner.token || lease.expiresAt <= Date.now()) {
        throw options.errors.lostLease(key);
      }
    };
    // Host retirement can stop renewal before ownership expires. Cleanup must
    // prove the retained lease itself without requiring the retired host run.
    assertCurrent();
    return assertCurrent;
  };

  return {
    captureLeaseAssertion,
    transact,
    withLease,
    hasLease: (key: string) => context.getStore()?.has(key) === true,
    owner: (key: string) => context.getStore()?.get(key),
  };
}

type NativeSessionBindingLease = { token: string; expiresAt: number };

export type NativeSessionBindingRecord = { lease?: NativeSessionBindingLease };

export type NativeSessionBindingStateStore<TRecord extends NativeSessionBindingRecord> = Pick<
  PluginStateSyncKeyedStore<TRecord>,
  "deleteIf" | "lookup" | "registerIfAbsent"
> & {
  withCurrent(authority: {
    assertCurrent: () => void;
  }): Pick<PluginStateKeyedStore<TRecord, 2>, "observe" | "compareAndApply">;
};

export type NativeSessionBindingLeaseOptions<TRecord extends NativeSessionBindingRecord> = {
  assertCurrent?: () => void;
  /** Undefined refuses acquisition without changing the current row. */
  prepareLease: (
    current: TRecord | undefined,
    lease: NativeSessionBindingLease,
  ) => TRecord | undefined;
};

export type NativeSessionBindingLeaseConfig<TRecord extends NativeSessionBindingRecord> = {
  readRecord: (raw: unknown) => TRecord | undefined;
  lease: { staleMs: number; waitMs: number; retryIntervalMs: number; renewIntervalMs: number };
  releaseTtlMs: (key: string, current: TRecord) => number | undefined;
  onReleaseFailure?: (key: string, error: unknown) => void;
  errors: {
    atomicUpdatesRequired: string;
    invalidRow: (key: string) => Error;
    lostLease: (key: string, cause?: unknown) => Error;
    leaseTimeout: (key: string) => Error;
    acquisitionRejected: (key: string) => Error;
  };
};

type NativeSessionBindingLeaseOwner = {
  token: string;
  phase: "held" | "deleted" | "closed";
  failure?: Error;
  assertCurrent?: () => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
