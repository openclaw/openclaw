import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  activateSecretsRuntimeSnapshotState as activateSnapshot,
  getActiveSecretsRuntimeSnapshotState as activeSnapshot,
  getActiveSecretsRuntimeSnapshotRevisionState as activeRevision,
  graftActiveSecretsRuntimeAuthState as graftAuthState,
  getPreparedSecretsRuntimeSnapshotRefreshContext,
  prepareSecretsRuntimeSnapshotRestoreState as prepareRestore,
  activateSecretsRuntimeSnapshotStateIfCurrent as restoreIfCurrent,
} from "../../secrets/runtime-state.js";
import { prepareSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import {
  loadPersistedAuthProfileStore as readPersistedStore,
  loadPersistedSharedAuthProfileStore as readSharedStore,
} from "./persisted.js";
import {
  listOwnedRuntimeAuthProfileStoreSnapshots as listSnapshots,
  prepareRuntimeAuthProfileStoreSnapshots,
  replaceOwnedRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot as setSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles as readStore,
  saveAuthProfileStoreIfPersistenceSnapshotMatches as saveIfUnchanged,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import {
  createAuthOwnerTestFixtures,
  persistOwnerProfile as persistProfile,
} from "./store-state-owner.test-support.js";
import {
  captureAuthProfileStorePersistenceSnapshot as capturePersistence,
  restoreAuthProfileStorePersistenceSnapshot as restorePersistence,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

const { tempDirs, saveOptions, apiKey, store, snapshotAt, unreadableOuter, seedRoot } =
  createAuthOwnerTestFixtures();

type Root = Awaited<ReturnType<typeof seedRoot>>;
function update(root: Root, agentDir: string | undefined, changes: Partial<AuthProfileStore>) {
  return updateAuthProfileStoreWithLock({
    stateDir: root.stateDir,
    agentDir,
    saveOptions,
    updater: (current) => {
      Object.assign(current, changes);
      return true;
    },
  });
}
const usageStats = (lastUsed: number) => ({ lastUsed, cooldownUntil: lastUsed + 60_000 });
function ownedBy(root: Root) {
  return listSnapshots().filter(({ databasePath }) =>
    [root.sharedPath, root.agentPath].includes(databasePath),
  );
}
function bindSnapshot(root: Root, agentDir: string) {
  withEnv(root.env, () => setSnapshot(readStore(agentDir), agentDir));
}
async function prepare(
  root: Root,
  agentDir: string,
  loadAuthStore = () => withEnv(root.env, () => readStore(agentDir)),
) {
  const snapshot = await prepareSecretsRuntimeSnapshot({
    config: {},
    env: root.env,
    agentDirs: [agentDir],
    loadAuthStore,
  });
  return { snapshot, refreshContext: getPreparedSecretsRuntimeSnapshotRefreshContext(snapshot) };
}
function commitShared(root: Root, baseline: ReturnType<typeof capturePersistence>, key: string) {
  return saveIfUnchanged({
    snapshot: baseline,
    stateDir: root.stateDir,
    store: store(key),
    options: saveOptions,
  });
}
function restoreActive(
  snapshot: NonNullable<ReturnType<typeof activeSnapshot>>,
  ownedSnapshot: typeof snapshot,
  expectedRevision: ReturnType<typeof activeRevision>,
) {
  expect(
    restoreIfCurrent(
      prepareRestore({
        snapshot,
        ownedSnapshot,
        expectedRevision,
        refreshContext: null,
        refreshHandler: null,
      })!,
    ),
  ).toBe(true);
}

describe("explicit auth state ownership", () => {
  it.each(["mixed-live", "cleared-local"] as const)(
    "preserves $0 bookkeeping ownership across shared-root activation",
    async (bookkeepingOwner) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const agentDir = first.agentDir;
      const profileId = "local";
      const updateBookkeeping = (root: Root, lastUsed: number) =>
        update(root, agentDir, { usageStats: { [profileId]: usageStats(lastUsed) } });

      const sharedProfileId = bookkeepingOwner === "cleared-local" ? "local" : "shared";
      await update(first, undefined, {
        profiles: {
          ...store("first").profiles,
          ...(bookkeepingOwner === "cleared-local" ? { local: apiKey("shared-local") } : {}),
        },
        usageStats: { [sharedProfileId]: usageStats(30) },
      });
      await updateBookkeeping(first, 10);
      if (bookkeepingOwner === "mixed-live") {
        await update(second, undefined, { usageStats: { shared: { lastUsed: 40 } } });
      }
      bindSnapshot(second, agentDir);
      const prepared = await prepare(first, agentDir);
      await closeOpenClawAgentDatabaseByPathAsync(first.agentPath);
      if (bookkeepingOwner === "cleared-local") {
        await updateAuthProfileStoreWithLock({
          stateDir: second.stateDir,
          agentDir,
          saveOptions,
          updater: (current) => {
            delete current.usageStats;
            return true;
          },
        });
      } else {
        await updateBookkeeping(second, 20);
      }
      activateSnapshot({ ...prepared, refreshHandler: null });
      const expectedLastUsed = bookkeepingOwner === "cleared-local" ? 30 : 20;
      const usage = snapshotAt(first.agentPath)?.usageStats;
      expect(usage?.[profileId]).toEqual(usageStats(expectedLastUsed));
      expect(usage?.[sharedProfileId]).toEqual(usageStats(30));
      expect(snapshotAt(first.agentPath)).toMatchObject({ runtimeInheritsMainState: true });
    },
  );

  it("keeps known public snapshot owners across an unrelated outer overlay update", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const assertOuterUnchanged = unreadableOuter("future");
    replaceRuntimeAuthProfileStoreSnapshots(
      listSnapshots().map((entry) => {
        if (entry.databasePath === first.agentPath) {
          entry.store.usageStats = { shared: { lastUsed: 123 } };
        }
        return entry;
      }),
    );
    await update(second, undefined, { profiles: { shared: apiKey("updated-second") } });
    expect(snapshotAt(second.agentPath)?.profiles.shared).toEqual(apiKey("updated-second"));
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("first"));
    assertOuterUnchanged();
  });

  it.each(["rollback", "newer-same", "graft"] as const)(
    "preserves shared-root authority through %s on one agent database",
    async (mode) => {
      const currentKey = mode === "newer-same" ? "second" : "third";
      const [first, second, third] = await Promise.all([
        seedRoot("first"),
        seedRoot("second"),
        seedRoot(currentKey),
      ]);
      const agentDir = tempDirs.make("openclaw-auth-owner-rebound-agent-");
      const agentPath = resolveAuthProfileDatabasePath(agentDir);
      if (mode === "rollback") {
        await persistProfile(first, "local", apiKey("stable-local"), agentDir);
        for (const [root, lastUsed] of [
          [first, 10],
          [second, 20],
        ] as const) {
          await update(root, undefined, { usageStats: { shared: { lastUsed } } });
        }
      }
      const activate = async (root: typeof first) => {
        const prepared = await prepare(root, agentDir);
        activateSnapshot({ ...prepared, refreshHandler: null });
      };
      await activate(first);
      const baseline = activeSnapshot()!;
      await activate(second);
      const owned = activeSnapshot()!;
      const revision = activeRevision();
      const expected = mode === "rollback" ? first : third;
      if (mode === "rollback") {
        await closeOpenClawAgentDatabaseByPathAsync(agentPath);
        await update(second, agentDir, { usageStats: { local: { lastUsed: 25 } } });
      }
      if (mode !== "rollback") {
        withEnv(third.env, () => setSnapshot(store(currentKey), agentDir));
      }
      vi.stubEnv("OPENCLAW_STATE_DIR", third.stateDir);
      if (mode === "graft") {
        const prepared = await prepare(first, agentDir);
        graftAuthState(prepared.snapshot);
        activateSnapshot({ ...prepared, refreshHandler: null });
      } else {
        restoreActive(baseline, owned, revision);
      }
      expect(snapshotAt(agentPath)?.profiles.shared).toEqual(
        apiKey(mode === "rollback" ? "first" : currentKey),
      );
      if (mode === "rollback") {
        expect(snapshotAt(agentPath)?.usageStats).toMatchObject({
          local: { lastUsed: 25 },
          shared: { lastUsed: 10 },
        });
      }
      await update(expected, undefined, { profiles: { shared: apiKey("updated-owner") } });
      expect(snapshotAt(agentPath)?.profiles.shared).toEqual(apiKey("updated-owner"));
    },
  );

  it("rejects a prepared snapshot after a scope-only owner transition", async () => {
    const first = await seedRoot("same");
    const second = await seedRoot("same");
    const agentDir = tempDirs.make("openclaw-auth-owner-stale-preparation-");
    withEnv(first.env, () => setSnapshot(store("same"), agentDir));
    const prepared = await prepare(first, agentDir, () => store("same"));
    withEnv(second.env, () => setSnapshot(store("same"), agentDir));
    expect(() => activateSnapshot({ ...prepared, refreshHandler: null })).toThrow("stale");
  });

  it("retains a removed snapshot owner through secrets activation rollback", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const captured = await withEnvAsync(first.env, async () => {
      const activate = async (authStores: Array<{ agentDir: string; store: AuthProfileStore }>) => {
        const prepared = await prepare(first, first.agentDir);
        prepared.snapshot.authStores = prepareRuntimeAuthProfileStoreSnapshots(authStores);
        activateSnapshot({ ...prepared, refreshHandler: null });
      };
      await activate([{ agentDir: first.agentDir, store: readStore(first.agentDir) }]);
      const baseline = activeSnapshot();
      await activate([]);
      const owned = activeSnapshot();
      assert(baseline && owned, "missing activated secrets snapshot");
      return { baseline, owned, revision: activeRevision() };
    });
    expect(snapshotAt(first.agentPath)).toBeUndefined();
    vi.stubEnv("OPENCLAW_STATE_DIR", second.stateDir);
    restoreActive(captured.baseline, captured.owned, captured.revision);
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("first"));
    await update(first, undefined, { profiles: { shared: apiKey("updated-first") } });
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("updated-first"));
    expect(readSharedStore(second.env)?.profiles.shared).toEqual(apiKey("second"));
  });

  it("ignores agent relocation when the selected shared owner is the state database", async () => {
    const root = await seedRoot("first");
    const relocated = tempDirs.make("openclaw-auth-owner-irrelevant-relocation-");
    withEnv({ ...root.env, OPENCLAW_AGENT_DIR: relocated }, () => {
      setSnapshot(readStore(root.agentDir), root.agentDir);
    });
    await update(root, undefined, { profiles: { shared: apiKey("updated") } });
    expect(snapshotAt(root.agentPath)?.profiles.shared).toEqual(apiKey("updated"));
    expect(fs.readdirSync(relocated)).toEqual([]);
  });

  it.each(["save", "rollback"] as const)(
    "rejects %s whose explicit state root disagrees with its owner",
    async (operation) => {
      const root = await seedRoot("first");
      const otherStateDir = tempDirs.make("openclaw-auth-owner-mismatch-");
      const baseline = capturePersistence(undefined, { stateDir: root.stateDir });
      if (operation === "save") {
        expect(() =>
          saveIfUnchanged({
            snapshot: baseline,
            stateDir: otherStateDir,
            store: store("must-not-write"),
            options: saveOptions,
          }),
        ).toThrow("owner");
      } else {
        const committed = commitShared(root, baseline, "committed");
        expect(() =>
          restorePersistence(baseline, committed.owned, undefined, { stateDir: otherStateDir }),
        ).toThrow("owner");
      }
      expect(readSharedStore(root.env)?.profiles.shared).toEqual(
        apiKey(operation === "save" ? "first" : "committed"),
      );
      expect(fs.readdirSync(otherStateDir)).toEqual([]);
    },
  );

  it("publishes and compensates only the selected root under invalid outer state", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const otherSnapshots = ownedBy(second);
    const assertOuterUnchanged = unreadableOuter("invalid");
    const baseline = capturePersistence(undefined, { stateDir: first.stateDir });
    const committed = commitShared(first, baseline, "temporary");
    expect(readSharedStore(first.env)?.profiles.shared).toEqual(apiKey("temporary"));
    expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("first"));
    expect(committed.publishRuntimeSnapshots()).toBe(true);
    expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("temporary"));
    const derived = snapshotAt(first.agentPath);
    expect(derived?.profiles).toMatchObject({
      shared: apiKey("temporary"),
      local: apiKey("first-local"),
    });
    assert(derived, "missing first-root derived snapshot");
    derived.profiles.external = {
      type: "token",
      provider: "anthropic",
      token: "runtime-only-fixture",
    };
    derived.runtimeExternalProfileIds = ["external"];
    replaceOwnedRuntimeAuthProfileStoreSnapshots(
      listSnapshots().map((entry) => {
        if (entry.databasePath === first.agentPath) {
          entry.store = derived;
        }
        return entry;
      }),
    );

    restorePersistence(baseline, committed.owned);

    expect(readSharedStore(first.env)?.profiles.shared).toEqual(apiKey("first"));
    expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("first"));
    expect(snapshotAt(first.agentPath)?.profiles).toEqual({
      shared: apiKey("first"),
      local: apiKey("first-local"),
      external: derived.profiles.external,
    });
    expect(ownedBy(second)).toEqual(otherSnapshots);
    expect(readSharedStore(second.env)?.profiles.shared).toEqual(apiKey("second"));
    assertOuterUnchanged();
  });

  it("keeps concurrent batch compensation bound to its captured shared owner", async () => {
    const roots = await Promise.all([seedRoot("first"), seedRoot("second")]);
    const assertOuterUnchanged = unreadableOuter("future");
    const receipts = await Promise.all(
      roots.map((root) => persistProfile(root, "attempt", apiKey(root.stateDir))),
    );
    const [firstReceipt, secondReceipt] = receipts;
    if (!firstReceipt || !secondReceipt) {
      throw new Error("missing batch compensation receipts");
    }
    await firstReceipt.rollback();
    expect(readSharedStore(roots[0].env)?.profiles.attempt).toBeUndefined();
    expect(readSharedStore(roots[1].env)?.profiles.attempt).toEqual(apiKey(roots[1].stateDir));
    expect(snapshotAt(roots[1].agentPath)?.profiles.attempt).toEqual(apiKey(roots[1].stateDir));
    await secondReceipt.rollback();
    await secondReceipt.rollback();
    for (const root of roots) {
      expect(readSharedStore(root.env)?.profiles.attempt).toBeUndefined();
      expect(snapshotAt(root.agentPath)?.profiles.attempt).toBeUndefined();
    }
    assertOuterUnchanged();
  });

  it("deduplicates OAuth against the selected shared owner, not an unrelated ambient owner", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const oauth: AuthProfileCredential = {
      type: "oauth",
      provider: "anthropic",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 600_000,
    };
    await persistProfile(second, "oauth", oauth);
    vi.stubEnv("OPENCLAW_STATE_DIR", second.stateDir);
    await persistProfile(first, "oauth", oauth, first.agentDir);
    expect(readPersistedStore(first.agentDir)?.profiles.oauth).toEqual(oauth);
    await persistProfile(first, "oauth", oauth);
    const freshAgentDir = tempDirs.make("openclaw-auth-owner-fresh-agent-");
    await update(first, freshAgentDir, { profiles: { oauth } });
    expect(readPersistedStore(freshAgentDir)?.profiles.oauth).toBeUndefined();
    // Existing local ownership is intentionally preserved, not retroactively deduplicated.
    expect(readPersistedStore(first.agentDir)?.profiles.oauth).toEqual(oauth);
    expect(readSharedStore(first.env)?.profiles.oauth).toEqual(oauth);
  });
});
