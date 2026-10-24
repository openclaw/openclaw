import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import type { WorkerTaskInput } from "../infra/worker-task-pool.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../state/user-model-account-authority.js";
import { writeAuthProfileJsonCell } from "./auth-profiles/sqlite-json-write.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import { catalogAgentFacts } from "./prepared-model-catalog-worker.shared.test-support.js";
import type {
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.types.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";

const transport = vi.hoisted(() => ({
  run: vi.fn<() => Promise<PreparedModelWorkerResult>>(),
}));

// mock-isolation: only transport is controlled; the host and retained credential owner are real.
vi.mock("./prepared-model-catalog-worker.pool.js", () => ({
  GATEWAY_CATALOG_WORKERS: 1,
  CatalogWorkerTaskPool: class {
    isClosed = false;
    constructor(
      _env: NodeJS.ProcessEnv,
      private readonly validate: (result: PreparedModelWorkerResult) => void,
    ) {}
    async run(input: WorkerTaskInput<PreparedModelCatalogWorkerTask>) {
      if (typeof input === "function") {
        await input();
      }
      const result = await transport.run();
      this.validate(result);
      return result;
    }
    async close() {
      this.isClosed = true;
    }
  },
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const paths: string[] = [];
afterEach(async () => {
  await closePreparedModelRuntimeSnapshots();
  for (const pathname of paths.splice(0)) {
    await closeOpenClawStateDatabaseByPathAsync(pathname);
  }
  transport.run.mockReset();
});

function fixture() {
  const stateDir = dirs.make("catalog-credential-publication-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawStateDatabase({ env });
  paths.push(database.path);
  const context = captureOpenClawStateWorkerContext({ env });
  const profileId = "fixture:credential";
  const credential = { type: "api_key", provider: "fixture", key: "synthetic-key" } as const;
  runOpenClawStateWriteTransaction(
    () =>
      writeAuthProfileJsonCell(database.db, "store", "shared-state", {
        version: 1,
        profiles: { [profileId]: credential },
      }),
    { database },
  );
  const capture = () =>
    captureAuthProfileCredentialAuthority(
      context,
      {
        identity: `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`,
        databasePath: database.path,
      },
      profileId,
    );
  const authority = capture();
  authority.observe(credential);
  const worker = createPreparedModelCatalogWorker({
    agentFacts: catalogAgentFacts({ config: {}, agentDir: path.join(stateDir, "agent"), env }, env),
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    isCurrent: () => true,
    retirementSignal: new AbortController().signal,
  });
  const dispatched = createDeferredCore();
  const outcome = createDeferredCore<PreparedModelWorkerResult>();
  transport.run.mockImplementation(() => {
    dispatched.resolve();
    return outcome.promise;
  });
  return { authority, capture, credential, worker, dispatched, outcome, database, profileId, env };
}

it("publishes a failed task's committed credential before releasing denial", async () => {
  const { credential, capture, authority, worker, database, profileId, env } = fixture();
  const next = { ...credential, key: "refreshed-synthetic-key" };
  const workerUrl = new URL(
    "./test-helpers/catalog-credential-publication.worker.ts",
    import.meta.url,
  );
  const pool = new WorkerTaskPool<
    { path: string; store: AuthProfileStore },
    PreparedModelWorkerResult
  >({
    workerUrl,
    maxWorkers: 1,
    workerOptions: { env, execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl) },
  });
  let prepared: ReturnType<typeof capture> | undefined;
  transport.run.mockImplementation(() => {
    prepared = capture();
    prepared.observe(credential);
    expect(() => prepared!.readCurrentCredential()).toThrow();
    expect(() => authority.readCurrentCredential()).toThrow();
    return pool.run(
      {
        path: database.path,
        store: { version: 1, profiles: { [profileId]: next } },
      },
      {},
    );
  });
  try {
    await expect(worker.loadAuth({ providerIds: [] })).rejects.toThrow(
      "catalog failed after credential refresh",
    );
    expect(authority.readCurrentCredential()).toEqual(next);
    prepared!.observe(credential);
    expect(prepared!.readCurrentCredential()).toEqual(next);
  } finally {
    await pool.close();
  }
});

it.each([
  { name: "releases confirmed credential facts before rejecting a failed result", known: true },
  { name: "keeps credential authority denied when the worker outcome is unknown", known: false },
])("$name", async ({ known }) => {
  const { worker, dispatched, authority, outcome, capture, credential } = fixture();
  const rejected = expect(worker.loadAuth({ providerIds: [] })).rejects.toThrow(
    known ? "synthetic catalog failure" : "worker terminated",
  );
  await dispatched.promise;
  expect(() => authority.readCurrentCredential()).toThrow();
  if (known) {
    outcome.resolve({
      status: "failed",
      error: "synthetic catalog failure",
      authCredentials: [],
    });
  } else {
    outcome.reject(new Error("worker terminated"));
  }
  await rejected;
  if (known) {
    expect(authority.readCurrentCredential()).toEqual(credential);
  } else {
    expect(() => authority.readCurrentCredential()).toThrow();
    const prepared = capture();
    prepared.observe(credential);
    expect(() => prepared.readCurrentCredential()).toThrow();
  }
});
