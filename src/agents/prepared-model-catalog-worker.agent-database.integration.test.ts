import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { sampleTrackedWorkerMemory } from "../infra/worker-cpu.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeDeletedAgentDatabases,
  reviveAgentDatabases,
} from "../state/openclaw-agent-db-readers.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { CatalogWorkerTaskPool } from "./prepared-model-catalog-worker.pool.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import { retirePreparedModelRuntimeAgent } from "./prepared-model-runtime.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import {
  loadCompletedFullCatalog,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, readCatalogWorkers } = usePreparedCatalogWorkerFixtures();
const createFleetFixture = createCatalogFleetFixture(makeTempDir);

// Leaving WAL needs an exclusive lock, which any connection in this process still refuses.
function leaveWalMode(databasePath: string): unknown {
  const db = new DatabaseSync(databasePath, { timeout: 0 });
  try {
    return db.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode;
  } finally {
    db.close();
  }
}

describe("Gateway catalog worker agent database readers", () => {
  it.each(["shared", "distinct"] as const)(
    "closes deleted agent readers and unused contexts with %s workspaces",
    async (workspaces) => {
      vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
      // Full-fleet publication also renews auth and closes readers outside this deletion scope.
      const fixture = await createFleetFixture(undefined, false, {
        publication: "individual",
        agentCount: 2,
        ...(workspaces === "distinct" ? { workspaces } : {}),
      });
      await Promise.all(
        (workspaces === "shared" ? fixture.snapshots.slice(0, 1) : fixture.snapshots).map(
          (snapshot) => loadCompletedFullCatalog(snapshot),
        ),
      );
      const catalogWorkers = readCatalogWorkers();
      expect(catalogWorkers).toHaveLength(1);
      const contextCount = () =>
        sampleTrackedWorkerMemory()
          .workerHeaps.find((sample) => sample.threadId === catalogWorkers[0]!.threadId)
          ?.retainedData?.find((row) => row.structure === "catalog-index")?.entries;
      await expect.poll(contextCount).toBe(workspaces === "distinct" ? 2 : 1);
      const [deleted, survivor] = fixture.agentIds.map((agentId) =>
        path.join(fixture.entries[agentId]!.agentDir, "openclaw-agent.sqlite"),
      );
      const retire = () =>
        retirePreparedModelRuntimeAgent({
          agentId: fixture.agentIds[0]!,
          agentDirs: [path.dirname(deleted!)],
          deleted: true,
        });
      if (workspaces === "shared") {
        const retirement = createDeferredCore();
        const events: string[] = [];
        const nativeWorker = catalogWorkers[0]!;
        const post = nativeWorker.postMessage.bind(nativeWorker);
        const posting = vi.spyOn(nativeWorker, "postMessage").mockImplementation((...args) => {
          if (isRecord(args[0])) {
            if ("input" in args[0] && !("responseId" in args[0])) {
              events.push("task");
            }
            if (args[0].closeResource) {
              events.push("close");
            }
          }
          post(...args);
        });
        const dispatch = vi
          .spyOn(CatalogWorkerTaskPool.prototype, "run")
          .mockImplementationOnce(function (
            this: CatalogWorkerTaskPool<unknown, unknown>,
            input,
            options,
          ) {
            dispatch.mockRestore();
            return this.run(() => {
              const selected = typeof input === "function" ? input() : input;
              expect(selected).not.toHaveProperty("value.pluginMetadataSnapshot");
              // Retirement must not overtake a compact first request from this new owner.
              queueMicrotask(() => void retire().then(retirement.resolve, retirement.reject));
              return selected;
            }, options);
          });
        try {
          const [auth] = await Promise.all([
            loadPreparedModelRuntimeAuth(fixture.snapshots[1]!, { providerIds: ["fleet-proof"] }),
            retirement.promise,
          ]);
          expect(auth?.authStore.profiles[`fleet:${fixture.agentIds[1]!}`]).toHaveProperty(
            "key",
            `synthetic-${fixture.agentIds[1]!}`,
          );
          expect(events).toEqual(["task", "close"]);
        } finally {
          dispatch.mockRestore();
          posting.mockRestore();
        }
      } else {
        await retire();
      }
      closeOpenClawAgentDatabasesForTest();

      try {
        expect(() => leaveWalMode(deleted!)).toThrow(/locked/);
        expect(() => leaveWalMode(survivor!)).toThrow(/locked/);
        await closeDeletedAgentDatabases(fixture.agentIds[0]!, [deleted!], {
          assertCurrentFinal() {},
          async assertCurrentAsync() {},
        });

        expect(leaveWalMode(deleted!)).toBe("delete");
        // Deletion must release a workspace's last context without evicting a shared survivor.
        await expect.poll(contextCount).toBe(1);
        const survivorProfileId = `fleet:${fixture.agentIds[1]!}`;
        const survivorProfile = {
          type: "api_key",
          provider: "fleet-proof",
          key: "synthetic-survivor-after-deletion",
        };
        const writer = new DatabaseSync(survivor!, { timeout: 0 });
        try {
          // A foreign commit must remain readable by the survivor's existing worker.
          writer.exec("BEGIN IMMEDIATE");
          expect(
            writer
              .prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = ?")
              .run(
                JSON.stringify({ version: 1, profiles: { [survivorProfileId]: survivorProfile } }),
                "primary",
              ).changes,
          ).toBe(1);
          writer.exec("COMMIT");
        } finally {
          writer.close();
        }
        using survivorPosts = vi.spyOn(catalogWorkers[0]!, "postMessage");
        const survivorAuth = await loadPreparedModelRuntimeAuth(fixture.snapshots[1]!, {
          providerIds: [survivorProfile.provider],
        });
        if (workspaces === "distinct") {
          const tasks = survivorPosts.mock.calls
            .map(([message]) => message)
            .filter(
              (message) => isRecord(message) && isRecord(message.input) && "value" in message.input,
            );
          expect(tasks).toHaveLength(1);
          expect(tasks[0]).not.toHaveProperty("input.value.pluginMetadataSnapshot");
        }
        expect(survivorAuth?.authStore.profiles[survivorProfileId]).toEqual(survivorProfile);
        expect(readCatalogWorkers()).toEqual(catalogWorkers);
        expect(catalogWorkers[0]!.threadId).not.toBe(-1);
      } finally {
        await reviveAgentDatabases([fixture.agentIds[0]!]);
      }
    },
  );
});
