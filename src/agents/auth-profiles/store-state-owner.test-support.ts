import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { withEnv } from "../../test-utils/env.js";
import { clearAuthProfileMigrationDiagnostics } from "./legacy-source-diagnostic.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath as getSnapshot,
  setRuntimeAuthProfileStoreSnapshot as setSnapshot,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfiles as loadStore } from "./store-runtime.js";
import type { AuthProfileCredential as Credential, AuthProfileStore as Store } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

export function createAuthOwnerTestFixtures() {
  const tempDirs = createTempDirTracker();
  const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
  const apiKey = (key: string): Credential => ({ type: "api_key", provider: "openai", key });
  const store = (key: string): Store => ({ version: 1, profiles: { shared: apiKey(key) } });
  const snapshotAt = (databasePath: string) => getSnapshot(databasePath)?.store;

  afterEach(async () => {
    clearSecretsRuntimeSnapshotState();
    clearRuntimeAuthProfileStoreSnapshots();
    clearAuthProfileMigrationDiagnostics();
    closeOpenClawAgentDatabasesForTest();
    await stateDatabase.closeOpenClawStateDatabaseAsync();
    stateDatabase.closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    tempDirs.cleanup();
  });

  function unreadableOuter(kind: "future" | "invalid") {
    const stateDir = tempDirs.make("openclaw-auth-owner-outer-");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    if (kind === "future") {
      const database = new DatabaseSync(databasePath);
      database.exec("PRAGMA user_version = 999");
      database.close();
    } else {
      fs.writeFileSync(databasePath, "invalid SQLite fixture");
    }
    const original = fs.readFileSync(databasePath);
    const relocated = path.join(stateDir, "unrelated-relocated-agent");
    const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: relocated };
    Object.entries(env).forEach(([name, value]) => vi.stubEnv(name, value));
    return () => {
      expect(fs.readFileSync(databasePath)).toEqual(original);
      expect(process.env).toMatchObject(env);
      expect(fs.existsSync(relocated)).toBe(false);
    };
  }

  async function seedRoot(key: string) {
    const stateDir = tempDirs.make("openclaw-auth-owner-root-");
    // Deliberately outside the state root: directory ancestry cannot identify inheritance.
    const agentDir = tempDirs.make("openclaw-auth-owner-custom-agent-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
    for (const dir of [undefined, agentDir]) {
      const profileId = dir === undefined ? "shared" : "local";
      const credential = apiKey(dir === undefined ? key : `${key}-local`);
      const profiles = [{ profileId, credential }];
      await persistAuthProfileBatch({ stateDir, agentDir: dir, profiles });
    }
    const sharedPath = resolveSharedAuthStorePath(env);
    const agentPath = resolveAuthProfileDatabasePath(agentDir);
    withEnv(env, () => [undefined, agentDir].forEach((dir) => setSnapshot(loadStore(dir), dir)));
    return { stateDir, agentDir, sharedPath, agentPath, env };
  }
  return { tempDirs, saveOptions, apiKey, store, snapshotAt, unreadableOuter, seedRoot };
}

export function persistOwnerProfile(
  { stateDir }: { stateDir: string },
  profileId: string,
  credential: Credential,
  agentDir?: string,
) {
  return persistAuthProfileBatch({ stateDir, agentDir, profiles: [{ profileId, credential }] });
}
