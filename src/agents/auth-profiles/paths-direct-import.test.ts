import fs from "node:fs";
import path from "node:path";
import { aroundEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { resolveLegacyAuthProfilesPath as resolveAuthStorePath } from "../../commands/doctor-auth-legacy-paths.js";
import { AuthStorage } from "../../plugin-sdk/agent-sessions.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnv } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./credential-fixtures.test-support.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import {
  withPreparedAuthStorePathForDisplay,
  resolveAuthStorePathForDisplay,
  resolveAuthStatePathForDisplay,
} from "./paths.js";
import * as snapshots from "./runtime-snapshots.js";
import { hasLocalAuthProfileStoreSource } from "./source-check.js";
import * as sqliteRead from "./sqlite-read.js";
import { closeAuthProfileReadPool } from "./sqlite.js";
import * as sqlite from "./sqlite.js";

let state: OpenClawTestState;
aroundEach((runTest) =>
  withOpenClawTestState({ scenario: "minimal" }, async (current) => {
    state = current;
    try {
      await runTest();
    } finally {
      snapshots.clearRuntimeAuthProfileStoreSnapshots();
    }
  }),
);

it.each([
  ["shared", false],
  ["missing", false],
  ["missing-row", false],
  ["present", true],
  ["unreadable", true],
  ["relocated", false],
  ["tilde", false],
] as const)("prepares the canonical display source without host SQL (%s)", async (mode, local) => {
  const agentId = "display";
  const agentDir = mode === "tilde" ? "~fake-openclaw-no-expand" : state.agentDir(agentId);
  const env = { ...state.env, ...(mode === "relocated" ? { OPENCLAW_AGENT_DIR: agentDir } : {}) };
  if (mode === "relocated") {
    withEnv({ OPENCLAW_AGENT_DIR: agentDir }, () => {
      expect(path.dirname(resolveAuthStorePath())).toBe(agentDir);
      expect(resolveAuthStorePathForDisplay()).toBe(path.join(agentDir, "openclaw-agent.sqlite"));
    });
  } else if (mode === "tilde") {
    const resolved = resolveAuthStorePathForDisplay(agentDir);
    expect(resolved).toBe(resolveSharedAuthStorePath());
  }
  const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
  if (mode === "missing-row") {
    agentDb.openOpenClawAgentDatabase({ agentId, env: state.env });
  } else if (local) {
    const profiles = {
      "fixture:display": createApiKeyCredential("fixture", "synthetic-display"),
    };
    await state.writeAuthProfiles({ version: 1, profiles }, agentId);
  }
  await agentDb.closeOpenClawAgentDatabasesAsync(state.stateDir);
  closeAuthProfileReadPool();
  if (mode === "unreadable") {
    fs.writeFileSync(databasePath, "not a SQLite database");
  }
  const sql = observeMainThreadSql();
  sql.calibrate();
  try {
    const source = mode === "shared" || mode === "relocated" ? undefined : agentDir;
    const displayPath = await AuthStorage.resolvePathForDisplayAsync(source, env);
    expect(displayPath).toBe(local ? databasePath : resolveSharedAuthStorePath(env));
    sql.expectIdle();
  } finally {
    sql.restore();
  }
  if (mode === "missing") {
    expect(fs.existsSync(databasePath)).toBe(false);
  }
});

it("does not invoke a withdrawn model build after its display worker read", async () => {
  await state.writeAuthProfiles({ version: 1, profiles: {} });
  await agentDb.closeOpenClawAgentDatabasesAsync(state.stateDir);
  closeAuthProfileReadPool();
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const original = sqliteRead.prepareAgentAuthProfileRowsRead;
  using _ = vi
    .spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead")
    .mockImplementation((options) => {
      const reader = original(options);
      return {
        ...reader,
        async read() {
          const rows = await reader.read();
          entered.resolve();
          await resume.promise;
          return rows;
        },
      };
    });
  const withdrawn = new Error("Model build authority was withdrawn");
  let current = true;
  const consume = vi.fn((pathname: string) => pathname);
  const reading = withPreparedAuthStorePathForDisplay(
    state.agentDir(),
    state.env,
    () => {
      if (!current) {
        throw withdrawn;
      }
    },
    consume,
  );
  const rejected = expect(reading).rejects.toBe(withdrawn);
  try {
    await awaitGateBeforeSettlement(entered.promise, rejected, "Read gate bypassed");
    current = false;
    resume.resolve();
    await rejected;
    expect(consume).not.toHaveBeenCalled();
  } finally {
    resume.resolve();
    await reading.catch(() => {});
  }
});

const persistedStore = createAuthProfileStoreFixture({
  "openai:test": createApiKeyCredential("openai", "test-key"),
});

describe("shared store ownership", () => {
  let paths: typeof import("./path-resolve.js");
  beforeEach(async () => {
    vi.resetModules();
    paths = await import("./path-resolve.js");
  });
  it("pins legacy ownership until an explicit commit and shares that commit across imports", async () => {
    const env = state.env;
    const legacyDir = (await import("./shared-main-dir.js")).resolveSharedMainAuthAgentDir(env);
    const expectedPath = path.join(legacyDir, "openclaw-agent.sqlite");

    expect(() => paths.resolveSharedAuthStoreOwnership(env)).toThrow("ownership is not prepared");
    await paths.prepareSharedAuthStoreOwnership(env);
    expect(paths.resolveSharedAuthStorePath(env)).toBe(expectedPath);

    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const aliasEnv = {
      ...env,
      OPENCLAW_STATE_DIR: path.join(env.OPENCLAW_STATE_DIR ?? "", "."),
    };

    expect(paths.resolveSharedAuthStorePath(aliasEnv)).toBe(expectedPath);

    sqlite.writePersistedAuthProfileStoreRaw(persistedStore, legacyDir);
    expect(resolveAuthStorePathForDisplay(legacyDir)).toBe(expectedPath);
    expect(resolveAuthStatePathForDisplay(legacyDir)).toBe(expectedPath);
    paths.noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
    expect(paths.resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
    expect(await paths.prepareSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });
    vi.resetModules();
    const sdkPaths = await import("./path-resolve.js");
    expect(sdkPaths.resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
  });

  it("ignores runtime-only external profiles when displaying store ownership", async () => {
    const env = state.env;
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const agentDir = path.join(env.OPENCLAW_STATE_DIR ?? "", "agents", "helper", "agent");

    sqlite.writePersistedAuthProfileStoreRaw(persistedStore);
    snapshots.setRuntimeAuthProfileStoreSnapshot(
      { ...persistedStore, runtimeExternalProfileIds: ["openai:test"] },
      agentDir,
    );

    expect(hasLocalAuthProfileStoreSource(agentDir)).toBe(true);
    expect(sqlite.inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
    expect(resolveAuthStorePathForDisplay(agentDir)).toBe(resolveOpenClawStateSqlitePath(env));
    expect(resolveAuthStatePathForDisplay(agentDir)).toBe(resolveOpenClawStateSqlitePath(env));
  });

  it("caches ownership independently for each canonical state root", async () => {
    const env = state.env;
    await paths.prepareSharedAuthStoreOwnership(env);
    expect(paths.resolveSharedAuthStoreOwnership(env)).toEqual({ location: "legacy-main" });
    await withOpenClawTestState({ layout: "state-only", applyEnv: false }, async (second) => {
      writeConfigMachineState(
        "auth.sharedStore",
        { location: "legacy-main", extra: true },
        { env: second.env },
      );
      await expect(paths.prepareSharedAuthStoreOwnership(second.env)).rejects.toThrow(
        expect.objectContaining({
          name: "InvalidSharedAuthStoreOwnershipError",
          code: "INVALID_SHARED_AUTH_STORE_OWNERSHIP",
          action: "openclaw doctor --fix",
        }),
      );
      expect(paths.resolveSharedAuthStoreOwnership(env)).toEqual({ location: "legacy-main" });
    });
  });
});
