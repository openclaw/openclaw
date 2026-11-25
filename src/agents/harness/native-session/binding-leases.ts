import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  SessionEntryCurrentCheck,
  SessionEntriesCurrentCheck,
} from "../../../config/sessions/session-entry-current.types.js";
import { materializeErrorStack } from "../../../infra/error-graph-internal.js";
import {
  capturePluginStateNativeBindingFacts,
  type PluginStatePinnedEntry,
} from "../../../plugin-state/plugin-state-native-binding-facts.js";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "../../../plugin-state/plugin-state-store.js";
import { capturePluginStateNativeBindingStore } from "../../../plugin-state/plugin-state-store.native-binding.js";
import { warnPluginSdkDeprecation } from "../../../plugins/sdk-deprecation.js";
import { sleep } from "../../../utils/sleep.js";
import type { NativeSessionBindingAuthority } from "./binding-authority.js";

/** Legacy adapter for released native binding stores. */
export function createNativeSessionBindingLeases<TRecord extends NativeSessionBindingRecord>(
  state: NativeSessionBindingStateStore<TRecord>,
  options: NativeSessionBindingLeaseConfig<TRecord>,
) {
  if (!state.withCurrent) {
    throw new Error(options.errors.atomicUpdatesRequired);
  }
  const leases = createNativeSessionBindingLeasesV2(
    {
      withCurrent: (authority) => state.withCurrent(authority),
      assertLeaseCurrent(key, token) {
        const raw = state.lookup(key);
        const current = options.readRecord(raw);
        if (raw !== undefined && !current) {
          throw options.errors.invalidRow(key);
        }
        if (current?.lease?.token !== token || current.lease.expiresAt <= Date.now()) {
          throw options.errors.lostLease(key);
        }
      },
    },
    options,
  );
  return {
    ...leases,
    captureLeaseAssertion(key: string) {
      const assertCurrent = leases.captureLeaseAssertion(key);
      assertCurrent();
      return assertCurrent;
    },
  };
}

/** Worker-owned mutations publish the facts used by synchronous native effect guards. */
export function createNativeSessionBindingLeasesV2<TRecord extends NativeSessionBindingRecord>(
  state: Pick<NativeSessionBindingStateStoreV2<TRecord>, "withCurrent" | "assertLeaseCurrent">,
  options: NativeSessionBindingLeaseConfig<TRecord>,
) {
  if (!state.withCurrent) {
    throw new Error(options.errors.atomicUpdatesRequired);
  }
  const context = new AsyncLocalStorage<Map<string, NativeSessionBindingLeaseOwner>>();
  const unresolved = new Map<string, { error: Error; custody: unknown }>();
  const assertSettled = (key: string) => {
    const blocked = unresolved.get(key);
    if (blocked) {
      throw blocked.error;
    }
  };
  const assertLeaseCurrent = (key: string, owner: NativeSessionBindingLeaseOwner) => {
    if (!owner.facts) {
      if (!state.assertLeaseCurrent) {
        throw new Error(options.errors.atomicUpdatesRequired);
      }
      warnPluginSdkDeprecation({
        family: "native-session-binding",
        method: "NativeSessionBindingStateStoreV2.assertLeaseCurrent",
        replacement: "withCurrent backed by api.runtime.state.openKeyedStoreV2",
      });
      state.assertLeaseCurrent(key, owner.token);
      return;
    }
    const current = readRecord(key, owner.facts.read());
    if (current?.lease?.token !== owner.token || current.lease.expiresAt <= Date.now()) {
      throw options.errors.lostLease(key);
    }
  };

  // Prepare data outside SQLite; the worker compares the complete observed row
  // and carries this action's authority through transaction and commit admission.
  const update = async (
    key: string,
    prepare: (raw: TRecord | undefined) => {
      next?: TRecord;
      ttlMs?: number;
    },
    assertCurrent?: () => void,
    authorities: readonly NativeSessionBindingAuthority[] = [],
  ): Promise<boolean> => {
    const mutations: Awaited<ReturnType<NativeSessionBindingAuthority["prepareMutation"]>>[] = [];
    for (const authority of new Set(authorities)) {
      mutations.push(await authority.prepareMutation());
    }
    const restrictions = mutations.flatMap(({ sessionEntryCurrent }) =>
      sessionEntryCurrent ? [sessionEntryCurrent] : [],
    );
    const sessionEntryCurrent: SessionEntriesCurrentCheck | undefined = restrictions.length
      ? {
          sources: restrictions.flatMap(({ sources }) => sources),
          assertCurrent: (entries) => {
            let offset = 0;
            for (const restriction of restrictions) {
              restriction.assertCurrent(entries.slice(offset, offset + restriction.sources.length));
              offset += restriction.sources.length;
            }
          },
        }
      : undefined;
    const store = state.withCurrent({
      sessionEntryCurrent,
      assertCurrent: () => {
        assertCurrent?.();
        for (const mutation of mutations) {
          mutation.assertCurrent();
        }
      },
    });
    let observed = await store.observe(key);
    while (true) {
      const prepared = prepare(observed.value);
      // Expiry during the worker wait is best effort; a replacement still changes
      // the compared row, and current caller authority gates the commit.
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
      observed = outcome.current;
    }
  };

  const transact = async <TResult>(
    key: string,
    apply: (
      current: TRecord | undefined,
      leaseToken?: string,
    ) => { next?: TRecord; result: TResult },
    ttlMs?: number | ((next: TRecord) => number | undefined),
    assertCurrent?: () => void,
    authority?: NativeSessionBindingAuthority,
  ): Promise<TResult> => {
    const deadline = performance.now() + options.lease.waitMs;
    while (true) {
      assertSettled(key);
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
        assertSettled(key);
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
          result = applied.result;
          return {
            next: applied.next,
            ttlMs: typeof ttlMs === "function" ? applied.next && ttlMs(applied.next) : ttlMs,
          };
        },
        assertOwnerCurrent,
        [authority, owner?.authority].filter((value) => value !== undefined),
      );
      if (leaseLost) {
        const failure = options.errors.lostLease(key);
        if (owner) {
          materializeErrorStack(failure);
          owner.failure = failure;
        }
        throw failure;
      }
      if (!busy) {
        return result;
      }
      if (performance.now() >= deadline) {
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
    assertSettled(key);
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
    const owner: NativeSessionBindingLeaseOwner = {
      token,
      phase: "held",
      assertCurrent: acquisition.assertCurrent,
      authority: acquisition.authority,
      renewalPending: () => renewal !== undefined,
      joinRenewal: async () => {
        await renewal;
      },
      quiesce() {
        if (renewal || owner.phase !== "held" || owner.failure) {
          throw owner.failure ?? options.errors.lostLease(key);
        }
        owner.phase = "settling";
      },
      block(error, custody) {
        materializeErrorStack(error);
        owner.phase = "unknown";
        owner.failure = error;
        unresolved.set(key, { error, custody });
      },
    };
    let renewal: Promise<void> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // Admission can write a token and then fail while releasing its reader.
    try {
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
        acquisition.authority,
      );
      acquisition.assertCurrent?.();
      if (!acquired) {
        throw options.errors.acquisitionRejected(key);
      }
      const bindingStore = capturePluginStateNativeBindingStore(
        state.withCurrent({ assertCurrent() {} }),
      );
      if (bindingStore) {
        owner.facts = await capturePluginStateNativeBindingFacts(bindingStore, key);
      }
      assertLeaseCurrent(key, owner);
      const nested = new Map(owned);
      nested.set(key, owner);
      // Exact-token renewal keeps bounded native requests serialized while a
      // replaced owner remains fenced, even when the request outlives one lease.
      heartbeat = setInterval(() => {
        if (!renewal && owner.phase === "held") {
          renewal = renew(key, owner).finally(() => {
            renewal = undefined;
          });
        }
      }, options.lease.renewIntervalMs);
      heartbeat.unref();
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
      const unknown = owner.phase === "unknown";
      if (!unknown) {
        owner.phase = "closed";
      }
      // A queued renewal must settle before release reads its final row. Its
      // admission guard also refuses after deletion or owner closure.
      try {
        await renewal;
        if (!unknown) {
          try {
            await update(key, (raw) => {
              const stored = readRecord(key, raw);
              if (stored?.lease?.token !== token) {
                return {};
              }
              const { lease: _lease, ...released } = stored;
              return {
                next: readRecord(key, released),
                ttlMs: options.releaseTtlMs(key, stored),
              };
            });
          } catch (error) {
            // Crashed or unauthorized owners leave their bounded lease to expire.
            options.onReleaseFailure?.(key, error);
          }
        }
      } finally {
        owner.facts?.release();
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
          };
        },
        () => {
          owner.assertCurrent?.();
          if (owner.phase !== "held" || owner.failure) {
            throw owner.failure ?? options.errors.lostLease(key);
          }
        },
        owner.authority ? [owner.authority] : [],
      );
      if (!stored && owner.phase === "held") {
        owner.failure = options.errors.lostLease(key);
        materializeErrorStack(owner.failure);
      }
    } catch (error) {
      if (owner.phase === "held") {
        owner.failure = options.errors.lostLease(key, error);
        materializeErrorStack(owner.failure);
      }
    }
  };

  const captureLeaseAssertion = (key: string): (() => void) => {
    const owner = context.getStore()?.get(key);
    if (!owner || owner.phase !== "held") {
      throw options.errors.lostLease(key);
    }
    const assertCurrent = () => {
      if (owner.phase !== "held") {
        throw options.errors.lostLease(key);
      }
      try {
        assertLeaseCurrent(key, owner);
      } catch (error) {
        throw owner.failure ?? error;
      }
    };
    // Host retirement can stop renewal before ownership expires. Cleanup must
    // prove the retained lease itself without requiring the retired host run.
    return assertCurrent;
  };

  return {
    captureLeaseAssertion,
    transact,
    withLease,
    hasLease: (key: string) => context.getStore()?.has(key) === true,
    owner: (key: string) => context.getStore()?.get(key),
    assertSettled,
    block(key: string, error: Error, custody: unknown) {
      materializeErrorStack(error);
      unresolved.set(key, { error, custody });
    },
  };
}

type NativeSessionBindingLease = { token: string; expiresAt: number };

export type NativeSessionBindingRecord = { lease?: NativeSessionBindingLease };

/**
 * @deprecated Use NativeSessionBindingStateStoreV2. Supported through 2026-12-31. Removal in the first January 2027 stable release.
 */
export type NativeSessionBindingStateStore<TRecord extends NativeSessionBindingRecord> = Pick<
  PluginStateSyncKeyedStore<TRecord>,
  "deleteIf" | "lookup" | "registerIfAbsent"
> & {
  withCurrent(authority: {
    assertCurrent: () => void;
    sessionEntryCurrent?: SessionEntryCurrentCheck | SessionEntriesCurrentCheck;
  }): Pick<PluginStateKeyedStore<TRecord, 2>, "observe" | "compareAndApply">;
};

export type NativeSessionBindingStateStoreV2<TRecord extends NativeSessionBindingRecord> = Pick<
  PluginStateKeyedStore<TRecord, 2>,
  "lookup"
> & {
  /**
   * @deprecated Worker-backed stores publish lease facts directly. Retained for external adapters
   * until removal in a later stable release after deprecation ships.
   */
  assertLeaseCurrent?(key: string, token: string): void;
  withCurrent: NativeSessionBindingStateStore<TRecord>["withCurrent"];
};

export type NativeSessionBindingLeaseOptions<TRecord extends NativeSessionBindingRecord> = {
  assertCurrent?: () => void;
  authority?: NativeSessionBindingAuthority;
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
  phase: "held" | "settling" | "deleted" | "unknown" | "closed";
  renewalPending(): boolean;
  joinRenewal(): Promise<void>;
  quiesce(): void;
  block(error: Error, custody: unknown): void;
  failure?: Error;
  facts?: PluginStatePinnedEntry;
  assertCurrent?: () => void;
  authority?: NativeSessionBindingAuthority;
};
