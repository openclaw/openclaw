import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import * as mutationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { pluginStatePublication } from "../../../plugin-state/plugin-state-publication.js";
import {
  createPluginStateKeyedStoreV2,
  type PluginStateActionAuthority,
} from "../../../plugin-state/plugin-state-store.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../../../test-utils/state-database-contention.js";
import { retainNativeSessionGenerationAuthority } from "./binding-generation-authority.js";
import { createNativeSessionBindingLeasesV2 } from "./binding-leases.js";
import {
  bindingTestOptions,
  prepareBindingTestLease,
  type TestBindingRecord,
} from "./binding.test-support.js";

function bindingStores(env: NodeJS.ProcessEnv) {
  const options = {
    namespace: "bindings",
    maxEntries: 10,
    overflowPolicy: "reject-new" as const,
    env,
  };
  const asyncState = createPluginStateKeyedStoreV2<TestBindingRecord>("binding-proof", options, {
    assertCurrent() {},
  });
  const state = {
    withCurrent(authority: PluginStateActionAuthority) {
      return createPluginStateKeyedStoreV2<TestBindingRecord>("binding-proof", options, authority);
    },
  };
  return {
    state,
    asyncState,
    owner: createNativeSessionBindingLeasesV2(state, bindingTestOptions),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native binding worker admission", () => {
  it.each(["lease", "action"] as const)(
    "refuses a binding write when its prepared %s lineage changes after observation",
    async (changed) => {
      await withOpenClawTestState({ label: "binding-worker-lineage" }, async (fixture) => {
        const { owner, state, asyncState } = bindingStores(fixture.env);
        const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: fixture.env });
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
            const entered = createDeferred();
            const resume = createDeferred();
            const withCurrent = state.withCurrent.bind(state);
            state.withCurrent = (authority) => {
              const store = withCurrent(authority);
              return {
                ...store,
                async observe(key) {
                  const observed = await store.observe(key);
                  entered.resolve();
                  await resume.promise;
                  return observed;
                },
              };
            };
            const pending = owner
              .transact(
                "binding",
                (record) => ({ next: { ...record, value: "unauthorized" }, result: true }),
                undefined,
                undefined,
                action.authority,
              )
              .catch((error: unknown) => error);
            try {
              await awaitGateBeforeSettlement(
                entered.promise,
                pending,
                "Binding observation was not reached",
              );
              await patchSessionEntryCore(scope(changed), () => ({ sessionId: "replacement" }));
            } finally {
              state.withCurrent = withCurrent;
              resume.resolve();
            }
            expect(await pending).toMatchObject({ message: `${changed} lineage superseded` });
            expect(await asyncState.lookup("binding")).toMatchObject({ value: "before" });
          },
          { prepareLease: prepareBindingTestLease, authority: lease.authority },
        );
      });
    },
  );

  it.each(["binding", "unicode-\ud800"])(
    "keeps %s native effect guards current from renewal, revocation, and unknown receipts",
    async (prefix) => {
      await withOpenClawTestState({ label: "binding-worker-facts" }, async (fixture) => {
        const { owner, asyncState } = bindingStores(fixture.env);
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
                const context = captureOpenClawStateWorkerContext({ env: fixture.env });
                pluginStatePublication.invalidateEntries(
                  { identity: context.admission.identity.key, incarnation: "unknown-settlement" },
                  [{ plugin_id: "binding-proof", namespace: "bindings", entry_key: key }],
                );
              }
              expect(assertCurrent).toThrow();
              if (mutation === "unknown") {
                await owner.owner(key)!.facts!.refresh();
                expect(assertCurrent).not.toThrow();
              }
            },
            { prepareLease: prepareBindingTestLease },
          );
          expect(retainedAssertion).toThrow("Lost binding lease");
        }
      });
    },
  );

  it("allows host progress to release a competing writer before persisting the binding", async () => {
    await withOpenClawTestState({ label: "binding-worker-contention" }, async (fixture) => {
      const { owner, asyncState } = bindingStores(fixture.env);
      await asyncState.register("binding", { value: "before" });
      const holder = holdStateDatabaseWriteTransaction(
        resolveOpenClawStateSqlitePath(fixture.env),
        1_000,
      );
      let settled = false;
      let mutation: Promise<{ value: string } | { error: unknown }> | undefined;
      let progressedBeforeSettlement = false;
      try {
        await holder.ready;
        mutation = owner
          .transact("binding", (current) => ({
            next: { ...current, value: "after" },
            result: "stored",
          }))
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
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
      const result = await mutation;
      expect(progressedBeforeSettlement).toBe(true);
      expect(result).toEqual({ value: "stored" });
      expect(await asyncState.lookup("binding")).toEqual({ value: "after" });
    });
  });

  it("refuses revocation at native commit without publishing a prepared binding", async () => {
    await withOpenClawTestState({ label: "binding-worker-authority" }, async (fixture) => {
      const { owner, asyncState } = bindingStores(fixture.env);
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
                return { next: { ...record, value: "unauthorized" }, result: true };
              },
              undefined,
              assertCurrent,
            );
          },
          {
            prepareLease: prepareBindingTestLease,
            assertCurrent,
          },
        ),
      ).rejects.toThrow();
      expect(refusedCommit).toBe(true);
      expect(entered).toBe(true);
      const stored = await asyncState.lookup("binding");
      expect(stored).toMatchObject({ value: "before" });
    });
  });
});
