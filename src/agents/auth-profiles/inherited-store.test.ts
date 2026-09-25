import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createExternalAuthRuntime } from "./external-auth.js";
import {
  loadInheritedAuthProfileStore,
  resolveRuntimeAuthProfileStoreFromSnapshots,
} from "./inherited-store.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { closeAuthProfileReadPool, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import { createAuthProfileStoreRuntime } from "./store.js";
import type { AuthProfileStore } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeAuthProfileReadPool();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.each(["shared-only", "local-and-shared"] as const)(
  "selects the scoped shared snapshot for %s auth reads",
  (mode) => {
    const ambientRoot = tempDirs.make("openclaw-auth-ambient-");
    const scopedRoot = tempDirs.make("openclaw-auth-scoped-");
    const env = { OPENCLAW_STATE_DIR: scopedRoot };
    const ambient: AuthProfileStore = {
      version: 1,
      profiles: {
        "custom:shared": { type: "api_key", provider: "custom", key: "ambient-fixture" },
      },
    };
    const scoped: AuthProfileStore = {
      version: 1,
      profiles: { "custom:shared": { type: "api_key", provider: "custom", key: "scoped-fixture" } },
    };
    const local: AuthProfileStore = {
      version: 1,
      profiles: { "custom:local": { type: "api_key", provider: "custom", key: "local-fixture" } },
    };
    vi.stubEnv("OPENCLAW_STATE_DIR", ambientRoot);
    noteCommittedSharedAuthStoreOwnership(
      { location: "state-db" },
      { OPENCLAW_STATE_DIR: ambientRoot },
    );
    setRuntimeAuthProfileStoreSnapshot(ambient);
    vi.stubEnv("OPENCLAW_STATE_DIR", scopedRoot);
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
    setRuntimeAuthProfileStoreSnapshot(scoped);
    const agentDir = path.join(scopedRoot, "agents/worker/agent");
    setRuntimeAuthProfileStoreSnapshot(local, agentDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", ambientRoot);

    const result = resolveRuntimeAuthProfileStoreFromSnapshots({
      ...(mode === "local-and-shared" ? { agentDir } : {}),
      env,
      loadStore: () => {
        throw new Error("All selected auth snapshots are already published");
      },
    });
    expect(result?.profiles).toEqual({
      ...scoped.profiles,
      ...(mode === "local-and-shared" ? local.profiles : {}),
    });
  },
);

it.each([
  "runtime",
  "secrets-runtime",
  "without-external",
  "ensure",
  "prepared-snapshot",
  "local-update",
] as const)("keeps local credentials through a refused inherited store via %s", (mode) => {
  const root = tempDirs.make("openclaw-inherited-admission-");
  const env = { OPENCLAW_STATE_DIR: root };
  const mainDir = path.join(root, "agents/main/agent");
  const workerDir = path.join(root, "agents/worker/agent");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_AGENT_DIR", mainDir);
  const local: AuthProfileStore = {
    version: 1,
    profiles: { "custom:local": { type: "api_key", provider: "custom", key: "local-fixture" } },
  };
  const inherited: AuthProfileStore = {
    version: 1,
    profiles: {
      "custom:shared": { type: "api_key", provider: "custom", key: "inherited-fixture" },
    },
  };
  const main = openOpenClawAgentDatabase({ agentId: "main", env });
  writePersistedAuthProfileStoreRaw(inherited, mainDir, main);
  const worker = openOpenClawAgentDatabase({ agentId: "worker", env });
  writePersistedAuthProfileStoreRaw(local, workerDir, worker);
  const mainPath = main.path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const original = fs.readFileSync(mainPath);
  const runtime = createAuthProfileStoreRuntime(createExternalAuthRuntime(() => []));
  const options = {
    inheritedAuthDir: mainDir,
    allowKeychainPrompt: false,
    readOnly: true,
    syncExternalCli: false,
    externalCli: { mode: "none" as const },
  };
  const read = () => {
    if (mode === "runtime") {
      return runtime.loadAuthProfileStoreForRuntime(workerDir, options);
    }
    if (mode === "secrets-runtime") {
      return runtime.loadAuthProfileStoreForSecretsRuntime(workerDir, options);
    }
    if (mode === "without-external") {
      return runtime.loadAuthProfileStoreWithoutExternalProfiles(workerDir, options);
    }
    if (mode === "local-update") {
      return runtime.ensureAuthProfileStoreForLocalUpdate(workerDir);
    }
    if (mode === "prepared-snapshot") {
      setRuntimeAuthProfileStoreSnapshot(local, workerDir);
    }
    return runtime.ensureAuthProfileStoreWithoutExternalProfiles(workerDir, options);
  };
  expect(read().profiles).toMatchObject({ ...inherited.profiles, ...local.profiles });
  closeAuthProfileReadPool();
  fs.writeFileSync(mainPath, "not a SQLite database");
  expect(read).toThrow(AuthProfileStoreUnreadableError);
  recordAgentDatabaseAdmissions(
    [
      createAgentDatabaseInspectionRefusal({
        agentId: "main",
        paths: [mainPath],
        reason: "The inherited database is unreadable.",
      }),
    ],
    { env, source: "startup" },
  );
  expect(read().profiles).toEqual(local.profiles);
  const unrelatedError = new AuthProfileStoreUnreadableError(path.join(root, "unrelated.sqlite"));
  expect(() =>
    loadInheritedAuthProfileStore(
      () => {
        throw unrelatedError;
      },
      mainDir,
      env,
    ),
  ).toThrow(unrelatedError);
  closeAuthProfileReadPool();
  fs.writeFileSync(mainPath, original);
  expect(read().profiles).toMatchObject({ ...inherited.profiles, ...local.profiles });
});
