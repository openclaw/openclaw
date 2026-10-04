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
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { createExternalAuthRuntime } from "./external-auth.js";
import {
  loadInheritedAuthProfileStore,
  readRuntimeAuthProfileStoreFromSnapshots,
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

function createStore(profileId: string, key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: { [profileId]: { type: "api_key", provider: "custom", key } },
  };
}

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
    const ambient = createStore("custom:shared", "ambient-fixture");
    const scoped = createStore("custom:shared", "scoped-fixture");
    const local = createStore("custom:local", "local-fixture");
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

    const read = readRuntimeAuthProfileStoreFromSnapshots({
      ...(mode === "local-and-shared" ? { agentDir } : {}),
      env,
    });
    const result = read.next();
    if (!result.done) {
      throw new Error("All selected auth snapshots are already published");
    }
    expect(result.value?.profiles).toEqual({
      ...scoped.profiles,
      ...(mode === "local-and-shared" ? local.profiles : {}),
    });
  },
);

it.each([
  "runtime",
  "without-external",
  "ensure",
  "prepared-snapshot",
  "local-update",
  "model-runtime",
  "model-snapshot",
] as const)("keeps local credentials through a refused inherited store via %s", async (mode) => {
  const root = tempDirs.make("openclaw-inherited-admission-");
  const env = { OPENCLAW_STATE_DIR: root };
  const mainDir = path.join(root, "agents/main/agent");
  const workerDir = path.join(root, "agents/worker/agent");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_AGENT_DIR", mainDir);
  const local = createStore("custom:local", "local-fixture");
  const inherited = createStore("custom:shared", "inherited-fixture");
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
  const read = async () => {
    if (mode === "model-runtime" || mode === "model-snapshot") {
      if (mode === "model-snapshot") {
        setRuntimeAuthProfileStoreSnapshot(local, workerDir);
      }
      const context = captureOpenClawStateWorkerContext({ env });
      return runtime.prepareAuthProfileStoreForModelRuntime(
        workerDir,
        { config: {}, inheritedAuthDir: mainDir },
        () => context.admission.assertCurrent(),
      );
    }
    if (mode === "runtime") {
      return runtime.loadAuthProfileStoreForRuntime(workerDir, options);
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
  expect((await read())?.profiles).toMatchObject({ ...inherited.profiles, ...local.profiles });
  closeAuthProfileReadPool();
  fs.writeFileSync(mainPath, "not a SQLite database");
  await expect(read()).rejects.toThrow(AuthProfileStoreUnreadableError);
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
  expect((await read())?.profiles).toEqual(local.profiles);
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
  expect((await read())?.profiles).toMatchObject({ ...inherited.profiles, ...local.profiles });
});

it.each(["explicit empty ids", "authoritative empty", "no overlay", "published overlay"] as const)(
  "prepares model auth from %s while preserving durable credentials and snapshot precedence",
  async (mode) => {
    const root = tempDirs.make("openclaw-model-auth-");
    const env = { OPENCLAW_STATE_DIR: root };
    const agentDir = path.join(root, "agents/main/agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const emptyOverlay = mode === "explicit empty ids" || mode === "authoritative empty";
    const durable: AuthProfileStore = emptyOverlay
      ? {
          version: 1,
          profiles: {
            "openai:default": {
              type: "oauth",
              provider: "openai",
              access: "durable-access-not-real",
              refresh: "durable-refresh-not-real",
              expires: Date.now() + 60_000,
            },
          },
        }
      : createStore("custom:durable", "durable-fixture");
    if (mode === "published overlay") {
      Object.assign(durable.profiles, createStore("custom:updated", "older-fixture").profiles);
    }
    const published: AuthProfileStore | undefined =
      mode === "no overlay"
        ? undefined
        : {
            ...durable,
            profiles: emptyOverlay
              ? durable.profiles
              : {
                  ...createStore("custom:updated", "published-fixture").profiles,
                  ...createStore("custom:external", "external-fixture").profiles,
                },
            runtimeExternalProfileIds:
              mode === "published overlay"
                ? ["custom:external"]
                : mode === "explicit empty ids"
                  ? []
                  : undefined,
            runtimeExternalProfileIdsAuthoritative: true,
          };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    writePersistedAuthProfileStoreRaw(durable, agentDir, database);
    if (published) {
      setRuntimeAuthProfileStoreSnapshot(published, agentDir);
    }
    if (emptyOverlay) {
      closeOpenClawAgentDatabasesForTest();
      closeAuthProfileReadPool();
      fs.writeFileSync(database.path, "The unused persisted source is unavailable");
    }
    const external = vi.fn(() => []);
    const runtime = createAuthProfileStoreRuntime(createExternalAuthRuntime(external));
    const context = captureOpenClawStateWorkerContext({ env });
    const result = await runtime.prepareAuthProfileStoreForModelRuntime(
      agentDir,
      { config: {}, inheritedAuthDir: agentDir },
      () => context.admission.assertCurrent(),
    );
    if (emptyOverlay) {
      expect(result?.profiles["openai:default"]).toEqual(durable.profiles["openai:default"]);
      expect(result?.runtimeExternalProfileIdsAuthoritative).toBe(true);
    } else {
      expect(result?.profiles).toEqual({ ...durable.profiles, ...published?.profiles });
      if (published) {
        expect(result?.runtimeExternalProfileIds).toEqual(["custom:external"]);
      }
    }
    if (published) {
      expect(external).not.toHaveBeenCalled();
    } else {
      expect(external).toHaveBeenCalledOnce();
    }
  },
);
