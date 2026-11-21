import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetFileLockStateForTest } from "../../plugin-sdk/file-lock.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { createOAuthRefreshCredential } from "./credential-fixtures.test-support.js";
import { resolveAuthProfileOrder } from "./order.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { markAuthProfileSuccess } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { SHARED_AUTH_CELL_KEYS, SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";

const FIRST_ID = "openai:first";
const SECOND_ID = "openai:second";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };

type Location = "agent-db" | "state-db";
type PersistedState = {
  lastGood?: Record<string, string>;
  usageStats?: Record<string, ProfileUsageStats>;
};

function createProfiles(): AuthProfileStore["profiles"] {
  const expires = Date.now() + 30 * 60 * 1000;
  const credential = (name: string) =>
    createOAuthRefreshCredential({ access: `${name}-access`, refresh: `${name}-refresh`, expires });
  return { [FIRST_ID]: credential("first"), [SECOND_ID]: credential("second") };
}

function createUsageStats(lastUsed: number): Record<string, ProfileUsageStats> {
  return { [FIRST_ID]: { lastUsed }, [SECOND_ID]: { lastUsed: lastUsed + 1 } };
}

describe("main-agent auth-profile usage", () => {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_AGENT_DIR"]);
  let mainAgentDir: string;

  beforeEach(() => {
    resetFileLockStateForTest();
    const rootDir = tempDirs.make("main-auth-owner-");
    mainAgentDir = path.join(rootDir, "agents", "main", "agent");
    fs.mkdirSync(mainAgentDir, { recursive: true });
    setTestEnvValue("OPENCLAW_STATE_DIR", rootDir);
    setTestEnvValue("OPENCLAW_AGENT_DIR", mainAgentDir);
    clearRuntimeAuthProfileStoreSnapshots();
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetFileLockStateForTest();
    env.restore();
  });

  /** Mirrors the layout the shared-auth migration leaves: credentials only in the state database. */
  function writeRelocatedSharedStore(lastUsed: number): void {
    saveAuthProfileStore({ version: 1, profiles: {} }, mainAgentDir, saveOptions);
    writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, process.env);
    writeConfigMachineState(SHARED_AUTH_CELL_KEYS.store, {
      version: 1,
      profiles: createProfiles(),
    });
    writeConfigMachineState(SHARED_AUTH_CELL_KEYS.state, {
      version: 1,
      usageStats: createUsageStats(lastUsed),
    });
  }

  function writeStore(location: Location, lastUsed: number): void {
    if (location === "state-db") {
      writeRelocatedSharedStore(lastUsed);
      return;
    }
    const store = {
      version: 1,
      profiles: createProfiles(),
      usageStats: createUsageStats(lastUsed),
    };
    saveAuthProfileStore(store, mainAgentDir, saveOptions);
  }

  function readPersistedState(location: Location): PersistedState | undefined {
    return location === "state-db"
      ? readConfigMachineState<PersistedState>(SHARED_AUTH_CELL_KEYS.state)
      : (loadPersistedAuthProfileStore(mainAgentDir) ?? undefined);
  }

  it.each(["agent-db", "state-db"] as const)(
    "records lastUsed for main-agent success when the shared store lives in %s",
    async (location) => {
      const previousUse = Date.now() - 60_000;
      writeStore(location, previousUse);
      const store = ensureAuthProfileStore(mainAgentDir);
      expect(resolveAuthProfileOrder({ store, provider: "openai" })[0]).toBe(FIRST_ID);

      await markAuthProfileSuccess({
        store,
        profileId: FIRST_ID,
        provider: "openai",
        agentDir: mainAgentDir,
      });

      const persisted = readPersistedState(location);
      expect(persisted?.usageStats?.[FIRST_ID]?.lastUsed).toBeGreaterThan(previousUse);
      expect(persisted?.lastGood?.openai).toBe(FIRST_ID);
      clearRuntimeAuthProfileStoreSnapshots();
      const next = ensureAuthProfileStore(mainAgentDir);
      expect(resolveAuthProfileOrder({ store: next, provider: "openai" })[0]).toBe(SECOND_ID);
    },
  );
});
