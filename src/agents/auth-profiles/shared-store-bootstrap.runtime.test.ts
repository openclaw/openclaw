import { describe, expect, it } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveSharedAuthStoreOwnership } from "./path-resolve.js";
import {
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  listOwnedRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { resolveAuthProfileDatabasePath, runAuthProfileWriteTransaction } from "./sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "./store-runtime.js";
import { createAuthOwnerTestFixtures } from "./store-state-owner.test-support.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const { tempDirs, apiKey, snapshotAt, seedRoot } = createAuthOwnerTestFixtures();

describe("fresh shared-auth snapshot ownership", () => {
  it("keeps views bound through a failed first credential write and a successful retry", async () => {
    const unrelated = await seedRoot("unrelated");
    const unrelatedBefore = getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(
      unrelated.agentPath,
    );
    const stateDir = tempDirs.make("openclaw-fresh-shared-auth-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
    const mainDir = resolveSharedMainAuthAgentDir(env);
    // The view belongs to this root through its owner receipt, not its directory location.
    const customDir = tempDirs.make("openclaw-fresh-shared-auth-custom-");
    const mainPath = resolveAuthProfileDatabasePath(mainDir);
    const customPath = resolveAuthProfileDatabasePath(customDir);
    withEnv(env, () => {
      setRuntimeAuthProfileStoreSnapshot(
        loadAuthProfileStoreWithoutExternalProfiles(mainDir),
        mainDir,
      );
      setRuntimeAuthProfileStoreSnapshot(
        {
          ...loadAuthProfileStoreWithoutExternalProfiles(customDir),
          profiles: { external: apiKey("runtime-only") },
          runtimeExternalProfileIds: ["external"],
          runtimeExternalCliProfileIds: ["external"],
        },
        customDir,
      );
    });
    const keysBefore = listOwnedRuntimeAuthProfileStoreSnapshots().map(
      ({ databasePath }) => databasePath,
    );
    expect(resolveSharedAuthStoreOwnership(env).location).toBe("legacy-main");
    expect(() =>
      runAuthProfileWriteTransaction(
        undefined,
        () => {
          throw new Error("credential write failed after bootstrap");
        },
        { env, sharedStoreWrite: true },
      ),
    ).toThrow("credential write failed after bootstrap");
    expect(resolveSharedAuthStoreOwnership(env).location).toBe("state-db");
    for (const databasePath of [mainPath, customPath]) {
      expect(getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(databasePath)?.owner).toEqual({
        kind: "resolved",
        location: "state-db",
        sharedDatabasePath: resolveOpenClawStateSqlitePath(env),
      });
    }
    expect(
      listOwnedRuntimeAuthProfileStoreSnapshots().map(({ databasePath }) => databasePath),
    ).toEqual(keysBefore);
    expect(snapshotAt(customPath)?.profiles.external).toEqual(apiKey("runtime-only"));

    await persistAuthProfileBatch({
      stateDir,
      profiles: [{ profileId: "shared", credential: apiKey("committed") }],
    });
    expect(snapshotAt(mainPath)?.profiles.shared).toEqual(apiKey("committed"));
    expect(snapshotAt(customPath)?.profiles).toMatchObject({
      shared: apiKey("committed"),
      external: apiKey("runtime-only"),
    });
    expect(getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(unrelated.agentPath)).toEqual(
      unrelatedBefore,
    );
  });
});
