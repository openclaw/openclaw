import { existsSync } from "node:fs";
import path from "node:path";
import { aroundEach, expect, it, vi } from "vitest";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createAuthProfileStoreFixture,
  createApiKeyCredential,
} from "./credential-fixtures.test-support.js";
import { resolveAuthStatePathForDisplay, resolveAuthStorePathForDisplay } from "./paths.js";
import * as snapshots from "./runtime-snapshots.js";
import { hasLocalAuthProfileStoreSource } from "./source-check.js";
import * as sqlite from "./sqlite.js";

const persistedStore = createAuthProfileStoreFixture({
  "openai:test": createApiKeyCredential("openai", "test-key"),
});

let env: NodeJS.ProcessEnv;
let paths: typeof import("./path-resolve.js");
aroundEach((runTest) =>
  withOpenClawTestState({ layout: "state-only" }, async (state) => {
    env = state.env;
    vi.resetModules();
    paths = await import("./path-resolve.js");
    try {
      await runTest();
    } finally {
      snapshots.clearRuntimeAuthProfileStoreSnapshots();
    }
  }),
);

it("keeps the absent ownership record pinned to the shipped legacy-main path", async () => {
  const legacyDir = (await import("./shared-main-dir.js")).resolveSharedMainAuthAgentDir(env);
  const expectedPath = path.join(legacyDir, "openclaw-agent.sqlite");

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
  expect(sqlite.inspectPersistedAuthProfileStoreRaw(legacyDir)).toMatchObject({
    status: "readable",
    raw: persistedStore,
  });
  expect(existsSync(expectedPath)).toBe(true);
});

it("ignores runtime-only external profiles when displaying store ownership", async () => {
  writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
  const agentDir = path.join(env.OPENCLAW_STATE_DIR ?? "", "agents", "helper", "agent");

  sqlite.writePersistedAuthProfileStoreRaw(persistedStore);
  snapshots.setRuntimeAuthProfileStoreSnapshot(
    {
      ...persistedStore,
      runtimeExternalProfileIds: ["openai:test"],
    },
    agentDir,
  );

  expect(hasLocalAuthProfileStoreSource(agentDir)).toBe(true);
  expect(sqlite.inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
  expect(resolveAuthStorePathForDisplay(agentDir)).toBe(resolveOpenClawStateSqlitePath(env));
  expect(resolveAuthStatePathForDisplay(agentDir)).toBe(resolveOpenClawStateSqlitePath(env));
});

it("caches ownership independently for each canonical state root", async () => {
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

it("requires preparation and follows committed ownership without another database read", async () => {
  expect(() => paths.resolveSharedAuthStoreOwnership(env)).toThrow("ownership is not prepared");
  await paths.prepareSharedAuthStoreOwnership(env);
  paths.noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
  expect(paths.resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
  expect(await paths.prepareSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });
  vi.resetModules();
  const sdkPaths = await import("./path-resolve.js");
  expect(sdkPaths.resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
});
