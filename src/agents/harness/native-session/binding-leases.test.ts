import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import * as sessionReads from "../../../config/sessions/session-entry-read-runtime.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import * as mutationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { pluginStatePublication } from "../../../plugin-state/plugin-state-publication.js";
import {
  createPluginStateKeyedStoreV2,
  type PluginStateActionAuthority,
} from "../../../plugin-state/plugin-state-store.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../../../test-utils/state-database-contention.js";
import { combineNativeSessionBindingAuthority } from "./binding-authority.js";
import { retainNativeSessionGenerationAuthority } from "./binding-generation-authority.js";
import {
  bindingGate,
  bindingMutation,
  interceptBindingStore,
} from "./binding-interleaving.test-support.js";
import {
  createNativeSessionBindingLeases,
  createNativeSessionBindingLeasesV2,
} from "./binding-leases.js";
import {
  bindingTestOptions,
  createBindingTestState,
  prepareBindingTestLease,
  type TestBindingRecord,
} from "./binding.test-support.js";

const testKey = "binding";

function createLeaseFixture() {
  const { state, values } = createBindingTestState();
  values.set(testKey, { value: "original" });
  return { state, values, owner: createNativeSessionBindingLeases(state, bindingTestOptions) };
}

function withLease<T>(
  owner: ReturnType<typeof createLeaseFixture>["owner"],
  key: string,
  run: () => Promise<T>,
  options: Omit<Parameters<typeof owner.withLease>[2], "prepareLease"> = {},
) {
  return owner.withLease(key, run, { prepareLease: prepareBindingTestLease, ...options });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native session binding leases", () => {
  let state: ReturnType<typeof createLeaseFixture>["state"];
  let values: ReturnType<typeof createLeaseFixture>["values"];
  let owner: ReturnType<typeof createLeaseFixture>["owner"];
  beforeEach(() => {
    vi.useFakeTimers();
    ({ state, values, owner } = createLeaseFixture());
  });
  const withBinding = <T>(
    fn: () => Promise<T>,
    options: Omit<Parameters<typeof owner.withLease>[2], "prepareLease"> = {},
  ) => withLease(owner, testKey, fn, options);
  const transact = <T>(apply: Parameters<typeof owner.transact<T>>[1]) =>
    owner.transact(testKey, apply);
  const readBinding = () => values.get(testKey);

  it("serializes peer writes behind a renewed binding lease", async () => {
    const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;
    await expect(
      withBinding(async () => {
        peerWrite = peer
          .transact(testKey, () => bindingMutation("peer"))
          .then((result) => {
            peerFinished = true;
            return result;
          });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(66_000);
        expect(peerFinished).toBe(false);
        const updated = await transact((current) => bindingMutation("updated", current));
        await Promise.resolve();
        expect(peerFinished).toBe(false);
        return updated;
      }),
    ).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(peerWrite).resolves.toBe(true);
    expect(readBinding()).toEqual({ value: "peer" });
  });

  it.each([-70_000, 70_000])(
    "keeps the lease wait deadline on the monotonic clock across a %d ms wall-clock jump",
    async (jumpMs) => {
      values.set(testKey, {
        value: "peer",
        lease: { token: "peer-owner", expiresAt: Date.now() + 120_000 },
      });
      const pending = transact((current) => ({ next: current, result: true }));
      // Observe rejection before advancing timers.
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      vi.setSystemTime(Date.now() + jumpMs);
      if (jumpMs > 0) {
        // Release only after checking the deadline against the forward wall-clock jump.
        await vi.advanceTimersByTimeAsync(1_000);
        values.set(testKey, { value: "peer" });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(settled).resolves.toBe(true);
      } else {
        // A wall-clock deadline would take ~140s; the monotonic budget stays at 70s.
        await vi.advanceTimersByTimeAsync(71_000);
        await expect(pending).rejects.toThrow("Binding lease timed out: binding");
        vi.clearAllTimers();
      }
    },
  );

  it.each(["transaction", "heartbeat"])(
    "fences a replaced lease at %s without deleting its successor",
    async (check) => {
      const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
      let successor: TestBindingRecord | undefined;
      await expect(
        withBinding(async () => {
          if (check === "transaction") {
            vi.setSystemTime(Date.now() + 66_000);
            await withLease(peer, testKey, async () => {
              await expect(
                peer.transact(testKey, (current) => bindingMutation("peer", current)),
              ).resolves.toBe(true);
            });
            await transact(() => bindingMutation("stale"));
          } else {
            successor = {
              ...readBinding(),
              lease: { token: "peer-owner", expiresAt: Date.now() + 120_000 },
            };
            values.set(testKey, successor);
            await vi.advanceTimersByTimeAsync(30_000);
          }
        }),
      ).rejects.toThrow("Lost binding lease");
      expect(readBinding()).toEqual(check === "transaction" ? { value: "peer" } : successor);
    },
  );

  it("preserves renewal failure after retained cleanup authority expires", async () => {
    const renewalCause = new Error("renewal observation failed");
    const renewalFailure = new Error(`Lost binding lease: ${testKey}`, { cause: renewalCause });
    owner = createNativeSessionBindingLeases(state, {
      ...bindingTestOptions,
      errors: {
        ...bindingTestOptions.errors,
        lostLease: (key, cause) =>
          cause === renewalCause ? renewalFailure : bindingTestOptions.errors.lostLease(key),
      },
    });
    let failNextObservation = false;
    interceptBindingStore(state, (store) => ({
      async observe(key) {
        if (failNextObservation) {
          failNextObservation = false;
          throw renewalCause;
        }
        return await store.observe(key);
      },
    }));
    await using gate = bindingGate();
    let assertRetainedLease!: () => void;
    const expiresAt = Date.now() + bindingTestOptions.lease.staleMs;
    const run = gate.observe(
      withBinding(async () => {
        assertRetainedLease = owner.captureLeaseAssertion(testKey);
        failNextObservation = true;
        await gate.pause();
        assertRetainedLease();
      }),
    );
    await gate.reached;
    await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
    vi.setSystemTime(expiresAt - 1);
    expect(assertRetainedLease).not.toThrow();
    vi.setSystemTime(expiresAt);
    gate.resume();
    expect(await run).toBe(renewalFailure);
  });

  it.each(["comparison refusal", "uncertain outcome"])(
    "handles %s without replaying an applied mutation",
    async (outcome) => {
      let replaced = false;
      interceptBindingStore(state, (store) => ({
        async compareAndApply(...args) {
          if (outcome === "comparison refusal" && !replaced) {
            replaced = true;
            values.set("binding", { value: "successor" });
          }
          const result = await store.compareAndApply(...args);
          if (outcome === "uncertain outcome") {
            throw new Error("storage outcome unknown");
          }
          return result;
        },
      }));
      const pending = transact((current) =>
        outcome === "uncertain outcome"
          ? bindingMutation(`${current?.value}:once`)
          : current?.value === "original"
            ? bindingMutation("updated")
            : { result: false },
      );
      if (outcome === "uncertain outcome") {
        await expect(pending).rejects.toThrow("storage outcome unknown");
        expect(readBinding()).toEqual({ value: "original:once" });
      } else {
        await expect(pending).resolves.toBe(false);
        expect(readBinding()).toEqual({ value: "successor" });
      }
    },
  );

  it("joins queued renewal before releasing a failed owner", async () => {
    let holdRenewal = false;
    await using runGate = bindingGate();
    await using renewalGate = bindingGate();
    interceptBindingStore(state, (store) => ({
      async observe(key) {
        if (holdRenewal) {
          holdRenewal = false;
          await renewalGate.pause();
        }
        return await store.observe(key);
      },
    }));
    let settled = false;
    const run = runGate.observe(
      withBinding(async () => {
        holdRenewal = true;
        await runGate.pause();
        throw new Error("native request failed");
      }).finally(() => {
        settled = true;
      }),
    );
    await runGate.reached;
    await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
    runGate.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    renewalGate.resume();
    expect(await run).toEqual(new Error("native request failed"));
    expect(readBinding()).toEqual({ value: "original" });
  });
  it("joins an accepted renewal before quiescing and admits no heartbeat during settlement", async () => {
    await using renewalGate = bindingGate();
    let pauseRenewal = false;
    interceptBindingStore(state, (store) => ({
      async compareAndApply(...args) {
        if (pauseRenewal) {
          pauseRenewal = false;
          await renewalGate.pause();
        }
        return store.compareAndApply(...args);
      },
    }));
    await withBinding(async () => {
      const held = owner.owner(testKey)!;
      const originalExpiry = readBinding()!.lease!.expiresAt;
      pauseRenewal = true;
      await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
      await renewalGate.reached;
      try {
        expect(() => held.quiesce()).toThrow("Lost binding lease");
        expect(readBinding()!.lease!.expiresAt).toBe(originalExpiry);
      } finally {
        renewalGate.resume();
      }
      await held.joinRenewal();
      expect(readBinding()!.lease!.expiresAt).toBeGreaterThan(originalExpiry);
      held.quiesce();
      const quiesced = structuredClone(readBinding());
      await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs * 2);
      expect(readBinding()).toEqual(quiesced);
      await expect(transact(() => bindingMutation("late"))).rejects.toThrow("Lost binding lease");
    });
    expect(readBinding()).toEqual({ value: "original" });
  });

  it("retains an uncertain generation after scope exit and lease expiry without replay or release", async () => {
    const failure = new SqliteWorkerError("native settlement lost", "outcome-unknown");
    let token: string | undefined;
    await expect(
      withBinding(async () => {
        const held = owner.owner(testKey)!;
        token = held.token;
        held.quiesce();
        held.block(failure, { key: testKey, token });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(readBinding()?.lease?.token).toBe(token);
    await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.staleMs * 2);
    const replay = vi.fn(async () => "replayed");
    await expect(withBinding(replay)).rejects.toBe(failure);
    await expect(transact(() => bindingMutation("replaced"))).rejects.toBe(failure);
    expect(replay).not.toHaveBeenCalled();
    expect(readBinding()).toMatchObject({ value: "original", lease: { token } });
    await expect(withLease(owner, "independent", async () => "available")).resolves.toBe(
      "available",
    );
  });

  it.each(["waiting", "prepared"] as const)(
    "refuses a %s mutation when settlement becomes unknown",
    async (phase) => {
      const waiting = phase === "waiting";
      await using leaseGate = bindingGate();
      await using mutationGate = bindingGate();
      const observed = createDeferred();
      let held: ReturnType<typeof owner.owner>;
      const lease = waiting
        ? leaseGate.observe(
            withBinding(async () => {
              held = owner.owner(testKey);
              await leaseGate.pause();
            }),
          )
        : Promise.resolve(undefined);
      if (waiting) {
        await leaseGate.reached;
      }
      interceptBindingStore(state, (store) => ({
        async compareAndApply(...args) {
          if (!waiting) {
            await mutationGate.pause();
          }
          const result = await store.compareAndApply(...args);
          if (args[2].action === "keep") {
            observed.resolve();
          }
          return result;
        },
      }));
      const apply = vi.fn(() => bindingMutation("late write"));
      // Start outside the lease's async context, after its first fence.
      const outcome = mutationGate.observe(transact(apply));
      const failure = new SqliteWorkerError("settlement outcome unknown", "outcome-unknown");
      try {
        await (waiting ? observed.promise : mutationGate.reached);
        if (waiting) {
          await vi.advanceTimersByTimeAsync(0);
          held!.block(failure, { key: testKey });
          values.delete(testKey);
          leaseGate.resume();
          expect(await lease).toBe(failure);
          await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.retryIntervalMs);
        } else {
          owner.block(testKey, failure, { key: testKey });
          mutationGate.resume();
        }
        expect(await outcome).toBe(failure);
        expect(apply).toHaveBeenCalledTimes(waiting ? 0 : 1);
        expect(readBinding()).toEqual(waiting ? undefined : { value: "original" });
      } finally {
        leaseGate.resume();
        await lease;
        mutationGate.resume();
        if (waiting) {
          await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.retryIntervalMs);
        }
        await outcome;
      }
    },
  );

  it.each([
    "expired",
    "storage-cleanup",
    "canceled-after-admission",
    "canceled-during-run",
  ] as const)(
    "cleans the exact token after %s without borrowing revoked caller authority",
    async (failureAt) => {
      const failure = new Error(failureAt);
      let active = true;
      const run = vi.fn(async () => {
        active = false;
        return "native-outcome";
      });
      interceptBindingStore(state, (store) => ({
        async compareAndApply(...args) {
          const result = await store.compareAndApply(...args);
          if (args[2].action === "set" && args[2].value.lease) {
            if (failureAt === "expired") {
              vi.setSystemTime(args[2].value.lease.expiresAt);
            }
            if (failureAt === "storage-cleanup") {
              throw failure;
            }
            if (failureAt === "canceled-after-admission") {
              active = false;
            }
          }
          return result;
        },
      }));
      const pending = withBinding(run, {
        authority: combineNativeSessionBindingAuthority(),
        assertCurrent: () => {
          if (!active) {
            throw failure;
          }
        },
      });
      if (failureAt === "expired") {
        await expect(pending).rejects.toThrow("Lost binding lease");
      } else {
        await expect(pending).rejects.toBe(failure);
      }
      expect(run).toHaveBeenCalledTimes(failureAt === "canceled-during-run" ? 1 : 0);
      expect(readBinding()).toEqual({ value: "original" });
    },
  );

  it("returns an accepted outcome without a new post-effect lineage read", async () => {
    const authority = combineNativeSessionBindingAuthority();
    let accepted = false;
    vi.spyOn(sessionReads, "withSessionEntriesFromStoresInWorker").mockImplementation(
      async (_reads, consume) => {
        if (accepted) {
          throw new Error("lineage changed after native acceptance");
        }
        return consume([]);
      },
    );
    await expect(
      withBinding(
        async () => {
          accepted = true;
          return { accepted: true };
        },
        { authority },
      ),
    ).resolves.toEqual({ accepted: true });
    expect(readBinding()?.lease).toBeUndefined();
  });
});

const leaseOptions = { prepareLease: prepareBindingTestLease };

function bindingStores(env: NodeJS.ProcessEnv) {
  const options = {
    namespace: "bindings",
    maxEntries: 10,
    overflowPolicy: "reject-new" as const,
    env,
  };
  const state = {
    withCurrent(authority: PluginStateActionAuthority) {
      return createPluginStateKeyedStoreV2<TestBindingRecord>("binding-proof", options, authority);
    },
  };
  return {
    state,
    asyncState: state.withCurrent({ assertCurrent() {} }),
    owner: createNativeSessionBindingLeasesV2(state, bindingTestOptions),
  };
}

it.each(["lease", "action"] as const)(
  "refuses a binding write when its prepared %s lineage changes after observation",
  async (changed) => {
    await withOpenClawTestState({ label: "binding-worker-lineage" }, async ({ env }) => {
      const { owner, state, asyncState } = bindingStores(env);
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
      const scope = (kind: string) => ({
        agentId: "main",
        storePath,
        sessionKey: `agent:main:${kind}`,
      });
      const retain = async (kind: string) => {
        await upsertSessionEntryCore(scope(kind), { sessionId: kind, updatedAt: 1 });
        return retainNativeSessionGenerationAuthority({
          target: { ...scope(kind), sessionId: kind },
          storePath,
          createSupersededError: () => new Error(`${kind} lineage superseded`),
        });
      };
      using captures = new DisposableStack();
      const lease = await retain("lease");
      captures.defer(() => lease.release());
      const action = await retain("action");
      captures.defer(() => action.release());
      await asyncState.register("binding", { value: "before" });
      await owner.withLease(
        "binding",
        async () => {
          await using gate = bindingGate();
          const restore = interceptBindingStore(state, (store) => ({
            async observe(key) {
              const observed = await store.observe(key);
              await gate.pause();
              return observed;
            },
          }));
          const pending = gate.observe(
            owner.transact(
              "binding",
              (record) => bindingMutation("unauthorized", record),
              undefined,
              undefined,
              action.authority,
            ),
          );
          try {
            await gate.wait(pending, "Binding observation was not reached");
            await patchSessionEntryCore(scope(changed), () => ({ sessionId: "replacement" }));
          } finally {
            restore();
            gate.resume();
          }
          expect(await pending).toMatchObject({ message: `${changed} lineage superseded` });
          expect(await asyncState.lookup("binding")).toMatchObject({ value: "before" });
        },
        { ...leaseOptions, authority: lease.authority },
      );
    });
  },
);

it.each(["binding", "unicode-\ud800"])(
  "keeps %s native effect guards current from renewal, revocation, and unknown receipts",
  async (prefix) => {
    await withOpenClawTestState({ label: "binding-worker-facts" }, async ({ env }) => {
      const { owner, asyncState } = bindingStores(env);
      for (const mutation of ["replace", "delete", "unknown"] as const) {
        const key = `${prefix}-${mutation}`;
        let retainedAssertion: (() => void) | undefined;
        await owner.withLease(
          key,
          async () => {
            const assertCurrent = owner.captureLeaseAssertion(key);
            retainedAssertion = assertCurrent;
            const current = (await asyncState.lookup(key))!;
            const lease = current.lease!;
            await asyncState.register(key, {
              ...current,
              lease: { ...lease, expiresAt: lease.expiresAt + 60_000 },
            });
            expect(assertCurrent).not.toThrow();
            if (mutation === "replace") {
              await asyncState.register(key, {
                ...current,
                lease: { ...lease, token: "replacement" },
              });
            } else if (mutation === "delete") {
              await asyncState.delete(key);
            } else {
              const stopFault = pluginStatePublication.subscribeFacts((change) => {
                if (change.kind === "committed") {
                  throw new Error("Synthetic binding publication failure");
                }
              });
              try {
                await asyncState.register(key, current);
              } finally {
                stopFault();
              }
            }
            expect(assertCurrent).toThrow();
          },
          leaseOptions,
        );
        expect(retainedAssertion).toThrow("Lost binding lease");
      }
    });
  },
);

it("allows host progress to release a competing writer before persisting the binding", async () => {
  await withOpenClawTestState({ label: "binding-worker-contention" }, async ({ env }) => {
    const { owner, asyncState } = bindingStores(env);
    await asyncState.register("binding", { value: "before" });
    const holder = holdStateDatabaseWriteTransaction(resolveOpenClawStateSqlitePath(env), 1_000);
    let settled = false;
    let mutation: Promise<string | { error: unknown }> | undefined;
    let progressedBeforeSettlement = false;
    try {
      await holder.ready;
      mutation = owner
        .transact("binding", (current) => ({
          next: { ...current, value: "after" },
          result: "stored",
        }))
        .catch((error: unknown) => ({ error }))
        .finally(() => {
          settled = true;
        });
      await immediate();
      progressedBeforeSettlement = !settled && Atomics.load(holder.released, 0) === 0;
    } finally {
      holder.release();
      await mutation;
      await holder.joined;
    }
    expect(progressedBeforeSettlement).toBe(true);
    expect(await mutation).toBe("stored");
    expect(await asyncState.lookup("binding")).toEqual({ value: "after" });
  });
});

it("refuses revocation at native commit without publishing a prepared binding", async () => {
  await withOpenClawTestState({ label: "binding-worker-authority" }, async ({ env }) => {
    const { owner, asyncState } = bindingStores(env);
    await asyncState.register("binding", { value: "before" });
    let current = true;
    let prepared = false;
    let entered = false;
    let refusedCommit = false;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("binding action revoked");
      }
    };
    probe.admission(mutationAdmission, (request, grant, admit) => {
      if (request.stage === "commit" && prepared && !refusedCommit) {
        refusedCommit = true;
        current = false;
      }
      admit(request, grant);
    });
    await expect(
      owner.withLease(
        "binding",
        () => {
          entered = true;
          return owner.transact(
            "binding",
            (record) => {
              prepared = true;
              return bindingMutation("unauthorized", record);
            },
            undefined,
            assertCurrent,
          );
        },
        { ...leaseOptions, assertCurrent },
      ),
    ).rejects.toThrow();
    expect({ refusedCommit, entered }).toEqual({ refusedCommit: true, entered: true });
    expect(await asyncState.lookup("binding")).toMatchObject({ value: "before" });
  });
});
