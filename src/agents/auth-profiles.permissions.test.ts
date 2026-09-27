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
import type { AuthProfileStore } from "./auth-profiles/types.js";

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

  it("keeps captured auth rows when pre-commit permission repair fails", () => {
    const stateDir = tempDirs.make("openclaw-auth-chmod-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const agentDir = join(stateDir, "agents", "main", "agent");
    const initial: AuthProfileStore = createAuthProfileStoreFixture({
      "openai:default": createApiKeyCredential("openai", "fake-initial"),
    });
    const next: AuthProfileStore = createAuthProfileStoreFixture({
      "openai:default": createApiKeyCredential("openai", "fake-next"),
    });
    writePersistedAuthProfileStoreRaw(initial, agentDir);
    const snapshot = captureAuthProfileStorePersistenceSnapshot(agentDir);
    const permissionError = Object.assign(new Error("EACCES: chmod failed"), {
      code: "EACCES",
    });
    if (process.platform !== "win32") {
      fs.chmodSync(resolveAuthProfileDatabasePath(agentDir), 0o644);
    }
    withChmodFailure(permissionError, () => {
      expect(() =>
        saveAuthProfileStoreIfPersistenceSnapshotMatches({
          agentDir,
          snapshot,
          store: next,
          options: {
            filterExternalAuthProfiles: false,
            syncExternalCli: false,
          },
        }),
      ).toThrow(permissionError);
    });

    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(initial);
  });

  it("does not publish a caller-owned save before permission repair commits", () => {
    const stateDir = tempDirs.make("openclaw-auth-overload-chmod-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const agentDir = join(stateDir, "agents", "main", "agent");
    const initial: AuthProfileStore = createAuthProfileStoreFixture({
      "openai:default": { type: "api_key", provider: "openai", key: "fake-initial" },
    });
    const next: AuthProfileStore = createAuthProfileStoreFixture({
      "openai:default": { type: "api_key", provider: "openai", key: "fake-next" },
    });
    writePersistedAuthProfileStoreRaw(initial, agentDir);
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: initial }]);
    const permissionError = Object.assign(new Error("EACCES: chmod failed"), {
      code: "EACCES",
    });
    if (process.platform !== "win32") {
      fs.chmodSync(resolveAuthProfileDatabasePath(agentDir), 0o644);
    }
    withChmodFailure(permissionError, () => {
      expect(() =>
        runAuthProfileWriteTransaction(agentDir, (database) => {
          saveAuthProfileStore(next, agentDir, undefined, database);
        }),
      ).toThrow(permissionError);
    });

    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(initial);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toEqual(initial);
  });
});
