// Load the model runtime test harness before its consumers.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeAuthProfileJsonCell } from "./auth-profiles/sqlite-json.js";
import {
  closeAuthProfileReadPool,
  writePersistedAuthProfileStoreRaw,
} from "./auth-profiles/sqlite.js";
import { AuthProfileStoreUnreadableError } from "./auth-profiles/store-unreadable-error.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "auth-read-contention" });

it.each(["released", "held"] as const)(
  "rebuilds one failed auth owner on demand with a %s database lock",
  async (fault) => {
    const workerDir = fixture.state.agentDir("worker");
    const db = openOpenClawAgentDatabase({ agentId: "worker" });
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "fixture:old": { type: "api_key", provider: "fixture", key: "synthetic-only" },
        },
      },
      workerDir,
      db,
    );
    const dbPath = db.path;
    closeAuthProfileReadPool();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fixture.mocks.configuredAgentIds = ["default", "worker"];
    await refreshPreparedModelRuntimeSnapshots(
      {},
      { gatewayLifecycle: true, catalogMode: "static" },
    );
    const load = (agentId: string) => loadPublishedGatewayReplyDispatchRuntime({ agentId });
    const latestWorkerRead = () =>
      fixture.mocks.discoverAuthStorage.mock.calls.findLast(([dir]) => dir === workerDir)?.[1];
    const before = await load("worker");
    expect(latestWorkerRead()).toMatchObject({
      preparedStore: { profiles: { "fixture:old": { provider: "fixture" } } },
    });
    const sibling = await load("default");
    const failed = createDeferred();
    let failures = 0;
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "failed") {
        failures++;
        failed.resolve();
      }
    });
    using writer = new DatabaseSync(dbPath);
    try {
      writer.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
      fixture.mocks.mutationListener?.({ agentDir: workerDir, affectsInheritedStores: false });
      await failed.promise;
      expect(await load("default")).toBe(sibling);
      if (fault === "released") {
        // Closing releases SQLite exclusive locking mode, including its retained read lock.
        writeAuthProfileJsonCell(writer, "store", "agent", { version: 1, profiles: {} });
        writer.exec("COMMIT");
        writer.close();
        const [first, concurrent] = await Promise.all([load("worker"), load("worker")]);
        expect(first?.agentId).toBe("worker");
        expect(first).not.toBe(before);
        expect(concurrent).toBe(first);
        expect(latestWorkerRead()).toHaveProperty("preparedStore.profiles");
        expect(latestWorkerRead()).not.toHaveProperty(["preparedStore", "profiles", "fixture:old"]);
        expect(failures).toBe(1);
      } else {
        await expect(load("worker")).rejects.toThrow();
        await expect(load("worker")).rejects.toThrow();
        expect(failures).toBe(2);
        writer.close();
        // No automatic retry or extra publication for requests during backoff.
        await expect(load("worker")).rejects.toThrow();
        expect(failures).toBe(2);
        const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
        try {
          const [first, concurrent] = await Promise.all([load("worker"), load("worker")]);
          expect(first?.agentId).toBe("worker");
          expect(first).not.toBe(before);
          expect(concurrent).toBe(first);
          expect(failures).toBe(2);
        } finally {
          now.mockRestore();
        }
      }
      expect(await load("default")).toBe(sibling);
    } finally {
      unregister();
    }
  },
  30000,
);

it("refuses to recover one member of a failed shared auth publication", async () => {
  fixture.mocks.configuredAgentIds = ["default", "worker"];
  await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true, catalogMode: "static" });
  const failed = createDeferred();
  const unregister = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "failed") {
      failed.resolve();
    }
  });
  try {
    fixture.mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw new AuthProfileStoreUnreadableError(fixture.state.path("shared-test.sqlite"));
    });
    fixture.mocks.mutationListener?.({ affectsInheritedStores: true });
    await failed.promise;
    const reads = fixture.mocks.discoverAuthStorage.mock.calls.length;
    for (const agentId of ["default", "worker"]) {
      await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId })).rejects.toThrow();
    }
    expect(fixture.mocks.discoverAuthStorage).toHaveBeenCalledTimes(reads);
  } finally {
    unregister();
  }
});

it("queues a failed read behind an unrelated owner's active auth publication", async () => {
  fixture.mocks.configuredAgentIds = ["default", "worker", "other"];
  await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true, catalogMode: "static" });
  const failed = createDeferred();
  const unregister = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "failed") {
      failed.resolve();
    }
  });
  try {
    const workerDir = fixture.state.agentDir("worker");
    fixture.mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw new AuthProfileStoreUnreadableError(workerDir);
    });
    fixture.mocks.mutationListener?.({ agentDir: workerDir, affectsInheritedStores: false });
    await failed.promise;
    fixture.mocks.mutationListener?.({
      agentDir: fixture.state.agentDir("other"),
      affectsInheritedStores: false,
    });
    const recovered = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    const result = expect(recovered).resolves.toMatchObject({ agentId: "worker" });
    await result;
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "other" }),
    ).resolves.toMatchObject({ agentId: "other" });
  } finally {
    unregister();
  }
});
