import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { AgentDatabaseSchemaAdmissionInvalidError } from "../../state/agent-database-admission-error.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import { createExternalAuthRuntime } from "./external-auth.js";
import { refreshAuthProfileFileState } from "./file-state.js";
import {
  loadInheritedAuthProfileStore,
  readRuntimeAuthProfileStoreFromSnapshots,
} from "./inherited-store.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
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

const withoutExternal = (read = () => []) =>
  createAuthProfileStoreRuntime(createExternalAuthRuntime(read, async (_params, run) => run()));

function inheritedFailure(error: Error, agentDir: string) {
  const read = () => {
    throw error;
  };
  return () => loadInheritedAuthProfileStore(read, agentDir, env);
}

let root: string;
let env: NodeJS.ProcessEnv;
let mainDir: string;
let workerDir: string;
beforeEach(() => {
  root = tempDirs.make("inherited-auth-");
  env = { OPENCLAW_STATE_DIR: root };
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  mainDir = path.join(root, "agents/main/agent");
  workerDir = path.join(root, "agents/worker/agent");
});

function persist(store: AuthProfileStore, agentId: string) {
  const database = openOpenClawAgentDatabase({ agentId, env });
  writePersistedAuthProfileStoreRaw(store, path.dirname(database.path), database);
  return database;
}

function replaceFile(file: string, contents: string | Buffer) {
  fs.writeFileSync(`${file}.replacement`, contents);
  fs.renameSync(`${file}.replacement`, file);
}

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeAuthProfileReadPool();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it("omits only the current inherited owner's pending admission", () => {
  const databasePath = path.join(mainDir, "openclaw-agent.sqlite");
  const pending = createAgentDatabaseInspectionRefusal({
    agentId: "main",
    paths: [databasePath],
    pending: true,
    reason: "Startup inspection is still preparing the owner",
  });
  recordAgentDatabaseAdmissions([pending], { env, source: "startup" });
  const error = new AgentDatabaseAdmissionError(pending);
  const read = inheritedFailure(error, mainDir);
  expect(read()).toBeUndefined();
  expect(inheritedFailure(error, workerDir)).toThrow(error);
  const wrongOwner = new AgentDatabaseAdmissionError({ ...pending, agentId: "worker" });
  expect(inheritedFailure(wrongOwner, mainDir)).toThrow(wrongOwner);

  // A failed or replaced admission must not be hidden by an earlier pending read.
  const failed = createAgentDatabaseInspectionRefusal({
    agentId: "main",
    paths: [databasePath],
    reason: "Owner inspection failed",
  });
  recordAgentDatabaseAdmissions([failed], { env, source: "startup" });
  expect(read).toThrow(error);
  const failure = new AgentDatabaseAdmissionError(failed);
  expect(inheritedFailure(failure, mainDir)).toThrow(failure);
});

it("preserves unreadable, schema and unexpected inherited-store failures", () => {
  recordAgentDatabaseAdmissions([], { env, source: "startup" });
  for (const error of [
    new AuthProfileStoreUnreadableError(path.join(mainDir, "openclaw-agent.sqlite")),
    new AgentDatabaseSchemaAdmissionInvalidError(),
    new Error("Owner store read failed"),
  ]) {
    expect(inheritedFailure(error, mainDir)).toThrow(error);
  }
});

it.each(["shared-only", "local-and-shared"] as const)(
  "selects the scoped shared snapshot for %s auth reads",
  (mode) => {
    const ambientRoot = tempDirs.make("openclaw-auth-ambient-");
    const scoped = createStore("custom:shared", "scoped-fixture");
    const local = createStore("custom:local", "local-fixture");
    const publish = (stateRoot: string, store: AuthProfileStore) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateRoot);
      noteCommittedSharedAuthStoreOwnership(
        { location: "state-db" },
        { OPENCLAW_STATE_DIR: stateRoot },
      );
      setRuntimeAuthProfileStoreSnapshot(store);
    };
    publish(ambientRoot, createStore("custom:shared", "ambient-fixture"));
    publish(root, scoped);
    setRuntimeAuthProfileStoreSnapshot(local, workerDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", ambientRoot);

    const result = readRuntimeAuthProfileStoreFromSnapshots({
      ...(mode === "local-and-shared" ? { agentDir: workerDir } : {}),
      env,
    }).next();
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
  "local-update-async",
  "model-runtime",
  "model-snapshot",
] as const)("keeps local credentials through a refused inherited store via %s", async (mode) => {
  vi.stubEnv("OPENCLAW_AGENT_DIR", mainDir);
  prepareSharedAuthStoreOwnershipForNative();
  const local = createStore("custom:local", "local-fixture");
  const inherited = createStore("custom:shared", "inherited-fixture");
  const mainPath = persist(inherited, "main").path;
  persist(local, "worker");
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const original = fs.readFileSync(mainPath);
  const runtime = withoutExternal();
  const options = {
    inheritedAuthDir: mainDir,
    allowKeychainPrompt: false,
    readOnly: true,
    syncExternalCli: false,
    externalCli: { mode: "none" as const },
  };
  const read = async () => {
    if (mode === "prepared-snapshot" || mode === "model-snapshot") {
      setRuntimeAuthProfileStoreSnapshot(local, workerDir);
    }
    if (mode === "model-runtime" || mode === "model-snapshot") {
      return prepareModel(runtime, workerDir, mainDir);
    }
    if (mode === "local-update" || mode === "local-update-async") {
      return mode === "local-update"
        ? runtime.ensureAuthProfileStoreForLocalUpdate(workerDir)
        : runtime.ensureAuthProfileStoreForLocalUpdateAsync(workerDir);
    }
    const methods = {
      runtime: "loadAuthProfileStoreForRuntime",
      "without-external": "loadAuthProfileStoreWithoutExternalProfiles",
      ensure: "ensureAuthProfileStoreWithoutExternalProfiles",
      "prepared-snapshot": "ensureAuthProfileStoreWithoutExternalProfiles",
    } as const;
    return runtime[methods[mode]](workerDir, options);
  };
  expect((await read())?.profiles).toMatchObject({ ...inherited.profiles, ...local.profiles });
  closeAuthProfileReadPool();
  // A replacement receives fresh admission; in-place foreign writes are not a runtime contract.
  replaceFile(mainPath, "not a SQLite database");
  await refreshAuthProfileFileState();
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
  const error = new AuthProfileStoreUnreadableError(path.join(root, "unrelated.sqlite"));
  expect(inheritedFailure(error, mainDir)).toThrow(error);
  closeAuthProfileReadPool();
  replaceFile(mainPath, original);
  await refreshAuthProfileFileState();
  expect((await read())?.profiles).toMatchObject({ ...inherited.profiles, ...local.profiles });
});

function prepareModel(
  runtime: ReturnType<typeof createAuthProfileStoreRuntime>,
  agentDir: string,
  inheritedAuthDir = agentDir,
) {
  const context = captureOpenClawStateWorkerContext({ env });
  return runtime.prepareAuthProfileStoreForModelRuntime(
    agentDir,
    { config: {}, inheritedAuthDir },
    () => context.admission.assertCurrent(),
  );
}

it.each(["explicit empty ids", "authoritative empty", "no overlay", "published overlay"] as const)(
  "prepares model auth from %s while preserving durable credentials and snapshot precedence",
  async (mode) => {
    const emptyOverlay = mode === "explicit empty ids" || mode === "authoritative empty";
    const durable: AuthProfileStore = emptyOverlay
      ? createAuthProfileStoreFixture({
          "openai:default": createOAuthRefreshCredential(),
        })
      : createStore("custom:durable", "durable-fixture");
    if (mode === "published overlay") {
      Object.assign(durable.profiles, createStore("custom:updated", "older-fixture").profiles);
    }
    const overlay: AuthProfileStore = {
      ...durable,
      runtimeExternalProfileIds: undefined,
      runtimeExternalProfileIdsAuthoritative: true,
    };
    if (mode === "explicit empty ids") {
      overlay.runtimeExternalProfileIds = [];
    } else if (mode === "published overlay") {
      overlay.profiles = {
        ...createStore("custom:updated", "published-fixture").profiles,
        ...createStore("custom:external", "external-fixture").profiles,
      };
      overlay.runtimeExternalProfileIds = ["custom:external"];
    }
    const published = mode === "no overlay" ? undefined : overlay;
    const database = persist(durable, "main");
    if (published) {
      prepareSharedAuthStoreOwnershipForNative();
      setRuntimeAuthProfileStoreSnapshot(published, mainDir);
    }
    if (emptyOverlay) {
      closeOpenClawAgentDatabasesForTest();
      closeAuthProfileReadPool();
      fs.writeFileSync(database.path, "The unused persisted source is unavailable");
    }
    const external = vi.fn(() => []);
    const runtime = withoutExternal(external);
    const result = await prepareModel(runtime, mainDir);
    if (emptyOverlay) {
      expect(result?.profiles["openai:default"]).toEqual(durable.profiles["openai:default"]);
      expect(result?.runtimeExternalProfileIdsAuthoritative).toBe(true);
    } else {
      expect(result?.profiles).toEqual({ ...durable.profiles, ...published?.profiles });
      if (published) {
        expect(result?.runtimeExternalProfileIds).toEqual(["custom:external"]);
      }
    }
    expect(external).toHaveBeenCalledTimes(published ? 0 : 1);
  },
);
