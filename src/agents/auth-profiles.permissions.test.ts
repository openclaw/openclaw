// Auth-profile saves must not report a failed transaction after rows became durable.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";

const {
  readPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} = await import("./auth-profiles/sqlite.js");
const { captureAuthProfileStorePersistenceSnapshot, getRuntimeAuthProfileStoreSnapshot } =
  await import("./auth-profiles/store.js");
const { saveAuthProfileStore, saveAuthProfileStoreIfPersistenceSnapshotMatches } =
  await import("./auth-profiles/store-runtime.js");
const { clearRuntimeAuthProfileStoreSnapshots, replaceRuntimeAuthProfileStoreSnapshots } =
  await import("./auth-profiles/runtime-snapshots.js");
const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function withChmodFailure(error: Error, operation: () => void): void {
  const chmod = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
    throw error;
  });
  try {
    // Native auth-store bindings and Vitest imports must observe the same builtin failure.
    syncBuiltinESMExports();
    operation();
  } finally {
    chmod.mockRestore();
    syncBuiltinESMExports();
  }
}

describe("auth-profile database permission repair", () => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it.each(["snapshot", "transaction"] as const)(
    "keeps persisted rows and runtime state when %s save permission repair fails",
    (mode) => {
      const stateDir = tempDirs.make("openclaw-auth-chmod-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const agentDir = join(stateDir, "agents", "main", "agent");
      const initial = createAuthProfileStoreFixture({
        "openai:default": createApiKeyCredential("openai", "fake-initial"),
      });
      const next = createAuthProfileStoreFixture({
        "openai:default": createApiKeyCredential("openai", "fake-next"),
      });
      writePersistedAuthProfileStoreRaw(initial, agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: initial }]);
      const snapshot =
        mode === "snapshot" ? captureAuthProfileStorePersistenceSnapshot(agentDir) : undefined;
      const permissionError = Object.assign(new Error("EACCES: chmod failed"), { code: "EACCES" });
      if (process.platform !== "win32") {
        fs.chmodSync(resolveAuthProfileDatabasePath(agentDir), 0o644);
      }
      withChmodFailure(permissionError, () => {
        expect(() => {
          if (snapshot) {
            saveAuthProfileStoreIfPersistenceSnapshotMatches({
              agentDir,
              snapshot,
              store: next,
              options: { filterExternalAuthProfiles: false, syncExternalCli: false },
            });
          } else {
            runAuthProfileWriteTransaction(agentDir, (database) => {
              saveAuthProfileStore(next, agentDir, undefined, database);
            });
          }
        }).toThrow(permissionError);
      });
      expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(initial);
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toEqual(initial);
    },
  );
});
