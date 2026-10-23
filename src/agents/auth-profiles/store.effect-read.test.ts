import { afterEach, expect, it, vi } from "vitest";
import * as sqliteWorker from "../../infra/sqlite-readonly-worker.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeAuthProfileStoreSnapshot } from "./runtime-snapshots.js";
import { createAuthProfileStoreRuntime } from "./store.js";
import type { AuthProfileStore } from "./types.js";

const runtime = createAuthProfileStoreRuntime({
  listRuntimeExternalAuthProfiles: () => [],
  overlayExternalAuthProfiles: (store) => store,
  withPreparedExternalAuthProfiles: async (_params, run) => run(),
});
const profileId = "fixture:selected";
const store: AuthProfileStore = {
  version: 1,
  profiles: {
    [profileId]: { type: "token", provider: "fixture", token: "synthetic-credential" },
  },
};
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
afterEach(() => vi.restoreAllMocks());

function revokeCredential(agentDir?: string) {
  return runtime.updateAuthProfileStoreWithLock({
    agentDir,
    saveOptions,
    updater(current) {
      delete current.profiles[profileId];
      return true;
    },
  });
}

it.each(["agent", "shared", "agent+shared"] as const)(
  "reads the admitted %s auth owner at an effect without main-thread SQL",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentDir = kind === "shared" ? undefined : state.agentDir("effect");
      const inherited: AuthProfileStore["profiles"] =
        kind === "agent+shared" ? { "fixture:shared": store.profiles[profileId]! } : {};
      runtime.saveAuthProfileStore({ version: 1, profiles: inherited }, undefined, saveOptions);
      runtime.saveAuthProfileStore(store, agentDir, saveOptions);
      const expected = { ...inherited, ...store.profiles };
      setRuntimeAuthProfileStoreSnapshot({ version: 1, profiles: {} }, agentDir);
      const agentRequests = vi.spyOn(sqliteWorker, "runSqliteReadOnlyWorker");
      const stateRequests = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
      const sql = observeMainThreadSql();
      sql.calibrate();
      let retained: (() => void) | undefined;
      try {
        await runtime.withAuthProfileStoreAtEffect(
          agentDir,
          {
            profileId,
            inheritedAuthDir: kind === "agent" ? agentDir : undefined,
            externalCli: { mode: "none" },
          },
          async (reader) => {
            retained = reader.assertCurrent;
            expect((await reader.read()).profiles).toEqual(expected);
            agentRequests.mockClear();
            stateRequests.mockClear();
            expect((await reader.read()).profiles).toEqual(expected);
            expect(agentRequests.mock.calls.length + stateRequests.mock.calls.length).toBe(1);
            reader.assertCurrent();
            sql.expectIdle();
          },
        );
        expect(retained).toThrow("no longer active");
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  },
);

it.each(["agent", "shared"] as const)(
  "refuses disclosure without rereading after the %s owner revokes a prepared credential",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentDir = kind === "agent" ? state.agentDir("effect") : undefined;
      runtime.saveAuthProfileStore({ version: 1, profiles: {} }, undefined, saveOptions);
      runtime.saveAuthProfileStore(store, agentDir, saveOptions);
      let disclosed = false;
      const sql = observeMainThreadSql();
      sql.calibrate();
      try {
        await expect(
          runtime.withAuthProfileStoreAtEffect(
            agentDir,
            { profileId, inheritedAuthDir: agentDir, externalCli: { mode: "none" } },
            async (reader) => {
              await reader.read();
              await revokeCredential(agentDir);
              reader.assertCurrent();
              disclosed = true;
            },
          ),
        ).rejects.toThrow("Auth profile store changed");
        expect(disclosed).toBe(false);
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  },
);

it("settles an accepted disclosure when credentials change afterward", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentDir = state.agentDir("effect");
    runtime.saveAuthProfileStore({ version: 1, profiles: {} }, undefined, saveOptions);
    runtime.saveAuthProfileStore(store, agentDir, saveOptions);
    let disclosures = 0;
    await runtime.withAuthProfileStoreAtEffect(
      agentDir,
      { profileId, inheritedAuthDir: agentDir, externalCli: { mode: "none" } },
      async (reader) => {
        await reader.read();
        reader.assertCurrent();
        disclosures++;
        await revokeCredential(agentDir);
      },
    );
    expect(disclosures).toBe(1);
  });
});

it("refuses disclosure without a live shared-state owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentDir = state.agentDir("effect");
    await expect(
      runtime.withAuthProfileStoreAtEffect(
        agentDir,
        { inheritedAuthDir: agentDir, externalCli: { mode: "none" } },
        (reader) => reader.read(),
      ),
    ).rejects.toThrow("requires a live shared-state owner");
  });
});
