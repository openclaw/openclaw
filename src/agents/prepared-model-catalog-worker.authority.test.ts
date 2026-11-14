import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
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
import {
  authProfileCredentialPublication,
  captureAuthProfileCredentialAuthority,
} from "../state/user-model-account-authority.js";
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
  close: vi.fn(),
  enqueued: vi.fn(),
}));

// mock-isolation: only transport is controlled; the host and retained credential owner are real.
vi.mock("./prepared-model-catalog-worker.pool.js", () => ({
  GATEWAY_CATALOG_WORKERS: 1,
  CatalogWorkerTaskPool: class {
    isClosed = false;
    private active = false;
    private queue: Array<() => void> = [];
    constructor(
      _env: NodeJS.ProcessEnv,
      private readonly validate: (result: PreparedModelWorkerResult) => void,
    ) {}
    run(input: WorkerTaskInput<PreparedModelCatalogWorkerTask>) {
      return new Promise<PreparedModelWorkerResult>((resolve, reject) => {
        this.queue.push(() => {
          const finish = (error?: unknown, result?: PreparedModelWorkerResult) => {
            try {
              if (error) {
                reject(toErrorObject(error, "Catalog transport failed"));
              } else {
                this.validate(result!);
                resolve(result!);
              }
            } catch (failure) {
              reject(toErrorObject(failure, "Catalog validation failed"));
            } finally {
              // Match WorkerTaskPoolCore.finish: dispatch before settled caller reactions run.
              this.active = false;
              this.dispatch();
            }
          };
          try {
            const prepared = typeof input === "function" ? input() : input;
            void Promise.resolve(prepared)
              .then(() => transport.run())
              .then((result) => finish(undefined, result), finish);
          } catch (error) {
            finish(error);
          }
        });
        transport.enqueued();
        this.dispatch();
      });
    }
    private dispatch() {
      if (!this.active && this.queue.length) {
        this.active = true;
        this.queue.shift()!();
      }
    }
    async close() {
      this.isClosed = true;
      transport.close();
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
  transport.close.mockReset();
  transport.enqueued.mockReset();
});

function fixture(options: { gatewayOwned?: true; isCurrent?: () => boolean } = {}) {
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
  const retirement = new AbortController();
  const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture();
  const createWorker = () =>
    createPreparedModelCatalogWorker({
      agentFacts: catalogAgentFacts(
        {
          config: {},
          agentDir: path.join(stateDir, "agent"),
          ...(options.gatewayOwned ? { allowGatewaySubagentBinding: true } : { env }),
        },
        env,
      ),
      pluginMetadataSnapshot,
      isCurrent: options.isCurrent ?? (() => true),
      retirementSignal: retirement.signal,
    });
  const worker = createWorker();
  const dispatched = createDeferredCore();
  const outcome = createDeferredCore<PreparedModelWorkerResult>();
  transport.run.mockImplementation(() => {
    dispatched.resolve();
    return outcome.promise;
  });
  return {
    authority,
    capture,
    credential,
    worker,
    dispatched,
    outcome,
    database,
    profileId,
    env,
    retirement,
    createWorker,
    identity: `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`,
  };
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

it("keeps credential authority denied when the worker outcome is unknown", async () => {
  const { worker, dispatched, authority, outcome, capture, credential } = fixture();
  const rejected = expect(worker.loadAuth({ providerIds: [] })).rejects.toThrow(
    "worker terminated",
  );
  await dispatched.promise;
  expect(() => authority.readCurrentCredential()).toThrow();
  outcome.reject(new Error("worker terminated"));
  await rejected;
  expect(() => authority.readCurrentCredential()).toThrow();
  const prepared = capture();
  prepared.observe(credential);
  expect(() => prepared.readCurrentCredential()).toThrow();
});

it("releases a failed catalog's retired owner while its shared worker stays warm", async () => {
  const reference = await (async () => {
    const owner = { current: true };
    const ownerReference = new WeakRef(owner);
    const { worker, dispatched, outcome, retirement } = fixture({
      gatewayOwned: true,
      isCurrent: () => owner.current,
    });
    const failed = expect(worker.loadAuth({ providerIds: [] })).rejects.toThrow("worker failed");
    await dispatched.promise;
    outcome.reject(new Error("worker failed"));
    await failed;
    owner.current = false;
    retirement.abort();
    return ownerReference;
  })();
  // Drop the mock's settled promise records; they are not production ownership roots.
  transport.run.mockReset();
  const control = new WeakRef({});
  await nextTurn();
  queryObjects(WeakRef);
  expect(control.deref()).toBeUndefined();
  expect(reference.deref()).toBeUndefined();
  expect(transport.close).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves a queued successor's publication with sibling=%s",
  async (sibling) => {
    const { worker, createWorker, identity } = fixture({ gatewayOwned: true });
    const successor = sibling ? createWorker() : worker;
    const firstEntered = createDeferredCore();
    const secondQueued = createDeferredCore();
    const secondEntered = createDeferredCore();
    const first = createDeferredCore<PreparedModelWorkerResult>();
    const second = createDeferredCore<PreparedModelWorkerResult>();
    transport.enqueued
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(secondQueued.resolve);
    transport.run
      .mockImplementationOnce(() => {
        firstEntered.resolve();
        return first.promise;
      })
      .mockImplementationOnce(() => {
        secondEntered.resolve();
        return second.promise;
      });
    const unknown: unknown[] = [];
    const unsubscribe = authProfileCredentialPublication.subscribeFacts((change) => {
      if (change.kind === "unknown" && change.identity === identity) {
        unknown.push(change);
      }
    });
    try {
      const failed = expect(worker.loadAuth({ providerIds: [] })).rejects.toThrow("worker failed");
      await firstEntered.promise;
      const completed = expect(
        successor.loadAuth({ providerIds: [], profileIds: ["second"] }),
      ).rejects.toThrow("known catalog failure");
      await secondQueued.promise;
      first.reject(new Error("worker failed"));
      await secondEntered.promise;
      await failed;
      expect(unknown).toHaveLength(1);
      second.resolve({ status: "failed", error: "known catalog failure", authCredentials: [] });
      await completed;
      expect(unknown).toHaveLength(1);
    } finally {
      first.reject(new Error("worker failed"));
      second.resolve({ status: "failed", error: "known catalog failure", authCredentials: [] });
      unsubscribe();
    }
  },
);
