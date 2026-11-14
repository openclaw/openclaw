import { afterEach, expect, it, vi } from "vitest";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeAuthProfileStoreSnapshot } from "./runtime-snapshots.js";
import { createAuthProfileStoreRuntime } from "./store.js";
import type { AuthProfileStore } from "./types.js";

const {
  saveAuthProfileStore: save,
  withAuthProfileStoreAtEffect: atEffect,
  updateAuthProfileStoreWithLock: update,
} = createAuthProfileStoreRuntime({
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
const withState = (run: Parameters<typeof withOpenClawTestState>[1]) =>
  withOpenClawTestState({ scenario: "minimal" }, run);
const options = (inheritedAuthDir?: string) => ({
  profileId,
  inheritedAuthDir,
  externalCli: { mode: "none" as const },
});
function seed(agentDir?: string, inherited: AuthProfileStore["profiles"] = {}) {
  save({ version: 1, profiles: inherited }, undefined, saveOptions);
  save(store, agentDir, saveOptions);
}

function revokeCredential(agentDir?: string) {
  return update({
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
    await withState(async (state) => {
      const agentDir = kind === "shared" ? undefined : state.agentDir("effect");
      const inherited: AuthProfileStore["profiles"] =
        kind === "agent+shared" ? { "fixture:shared": store.profiles[profileId]! } : {};
      seed(agentDir, inherited);
      const expected = { ...inherited, ...store.profiles };
      setRuntimeAuthProfileStoreSnapshot({ version: 1, profiles: {} }, agentDir);
      const sql = observeMainThreadSql();
      sql.calibrate();
      let retained: (() => void) | undefined;
      try {
        await atEffect(
          agentDir,
          options(kind === "agent" ? agentDir : undefined),
          async (reader) => {
            retained = reader.assertCurrent;
            expect((await reader.read()).profiles).toEqual(expected);
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
    await withState(async (state) => {
      const agentDir = kind === "agent" ? state.agentDir("effect") : undefined;
      seed(agentDir);
      let disclosed = false;
      const sql = observeMainThreadSql();
      sql.calibrate();
      try {
        await expect(
          atEffect(agentDir, options(agentDir), async (reader) => {
            await reader.read();
            await revokeCredential(agentDir);
            reader.assertCurrent();
            disclosed = true;
          }),
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
  await withState(async (state) => {
    const agentDir = state.agentDir("effect");
    seed(agentDir);
    let disclosures = 0;
    await atEffect(agentDir, options(agentDir), async (reader) => {
      await reader.read();
      reader.assertCurrent();
      disclosures++;
      await revokeCredential(agentDir);
    });
    expect(disclosures).toBe(1);
  });
});

it("refuses disclosure without a live shared-state owner", async () => {
  await withState(async (state) => {
    const agentDir = state.agentDir("effect");
    await expect(
      atEffect(agentDir, { inheritedAuthDir: agentDir, externalCli: { mode: "none" } }, (reader) =>
        reader.read(),
      ),
    ).rejects.toThrow("requires a live shared-state owner");
  });
});
