import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { threadId, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginMetadataSnapshotCache, retirePluginCache } from "../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import {
  getPreparedModelCatalogWorkerPoolSnapshot,
  PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
} from "./prepared-model-catalog-worker.js";
import {
  EXTERNAL_AUTH_PATH_ENV,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
  createCatalogFixture,
  writeFixturePlugin,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import {
  getPreparedModelFullCatalogAuth,
  loadPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import {
  closePreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimeClose,
} from "./prepared-model-runtime.lifecycle.js";
import {
  loadCompletedFullCatalog,
  readCatalogDiscoveryCaptures,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();

async function createFleetFixture() {
  const fixture = createCatalogFixture(makeTempDir, 0);
  for (const name of [
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_WORKER_CATALOG_MARKER",
    EXTERNAL_AUTH_PATH_ENV,
    REF_ONLY_API_ENV,
    REF_ONLY_TOKEN_ENV,
  ] as const) {
    vi.stubEnv(name, fixture.env[name]);
  }
  const agentIds = ["fleet-a", "fleet-b", "fleet-c", "fleet-d"];
  const entries = Object.fromEntries(
    agentIds.map(
      (id) =>
        [
          id,
          {
            agentDir: path.join(fixture.env.OPENCLAW_STATE_DIR!, "agents", id, "agent"),
            workspace: path.join(fixture.root, `${id}-workspace`),
          },
        ] as const,
    ),
  );
  const config = {
    ...fixture.config,
    agents: { ...fixture.config.agents, entries },
  } satisfies OpenClawConfig;
  for (const id of agentIds) {
    fs.mkdirSync(entries[id]!.workspace, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [`fleet:${id}`]: { type: "api_key", provider: "fleet-proof", key: `synthetic-${id}` },
        },
      },
      entries[id]!.agentDir,
    );
  }
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    allowGatewaySubagentBinding: true,
    catalogMode: "static",
    pluginMetadataSnapshot: loadPluginMetadataSnapshot({
      config,
      env: process.env,
      workspaceDir: fixture.workspaceDir,
    }),
  });
  const snapshots = agentIds.map((agentId) =>
    getPreparedModelRuntimeSnapshot({
      agentId,
      agentDir: entries[agentId]!.agentDir,
      config,
    })!,
  );
  return { ...fixture, config, entries, snapshots, agentIds };
}

describe("Gateway catalog worker pool", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
  });
  it("reuses one Gateway catalog worker and source graph across agent publications", async () => {
    const fixture = await createFleetFixture();
    const { snapshots, agentIds } = fixture;
    const spawned: Worker[] = [];
    const workerChannel = channel("worker_threads");
    const recordWorker = (message: unknown) => {
      if (isRecord(message) && message.worker instanceof Worker) {
        spawned.push(message.worker);
      }
    };
    workerChannel.subscribe(recordWorker);
    try {
      await loadCompletedFullCatalog(snapshots[0]!);
      const initialCaptures = new Set(
        readCatalogDiscoveryCaptures(fixture.root)
          .filter((capture) => capture.threadId !== threadId)
          .map((capture) => capture.filename),
      );
      expect(initialCaptures.size).toBeGreaterThan(0);
      writeFixturePlugin({ root: fixture.root, spinMs: 0, pluginVersion: "v2" });
      const catalogs = await Promise.all(
        snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)),
      );
      expect(spawned).toHaveLength(1);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        maxWorkers: 1,
        workers: 1,
        workersCreated: 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
      for (const [index, catalog] of catalogs.entries()) {
        expect(catalog.entries).toContainEqual(
          expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
        );
        const auth = getPreparedModelFullCatalogAuth(catalog)!;
        expect(auth.authStore.profiles[`fleet:${agentIds[index]}`]).toMatchObject({
          key: `synthetic-${agentIds[index]}`,
        });
        expect(
          Object.keys(auth.authStore.profiles).filter((id) => id.startsWith("fleet:")),
        ).toEqual([`fleet:${agentIds[index]}`]);
      }
      const captures = new Set(
        readCatalogDiscoveryCaptures(fixture.root)
          .filter((capture) => capture.threadId !== threadId)
          .map((capture) => capture.filename),
      );
      expect(captures).toEqual(initialCaptures);
    } finally {
      workerChannel.unsubscribe(recordWorker);
    }
  });
  it("republishes failed catalog borrowers before replacing their source worker", async () => {
    const fixture = await createFleetFixture();
    const spawned: Worker[] = [];
    let peakWorkers = 0;
    const workerChannel = channel("worker_threads");
    const recordWorker = (message: unknown) => {
      if (isRecord(message) && message.worker instanceof Worker) {
        spawned.push(message.worker);
        peakWorkers = Math.max(
          peakWorkers,
          spawned.filter((worker) => worker.threadId !== -1).length,
        );
      }
    };
    workerChannel.subscribe(recordWorker);
    try {
      await Promise.all(
        fixture.snapshots.map((snapshot) =>
          loadPreparedModelRuntimeAuth(snapshot, { providerIds: [PROVIDER_ID] }),
        ),
      );
      expect(spawned).toHaveLength(1);
      writeFixturePlugin({ root: fixture.root, spinMs: 0, pluginVersion: "v2" });
      await spawned[0]!.terminate();
      await expect(
        loadPreparedModelRuntimeAuth(fixture.snapshots[0]!, { providerIds: [] }),
      ).rejects.toThrow();
      expect(fixture.snapshots.every((snapshot) => !snapshot.isCurrent())).toBe(true);
      const replacement = getPreparedModelRuntimeSnapshot({
        agentId: fixture.agentIds[0],
        agentDir: fixture.entries[fixture.agentIds[0]!]!.agentDir,
        config: fixture.config,
      })!;
      expect(replacement).not.toBe(fixture.snapshots[0]);
      const catalog = await loadCompletedFullCatalog(replacement, { refresh: true });
      expect(catalog.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v2" }),
      );
      expect(spawned).toHaveLength(2);
      expect(peakWorkers).toBe(1);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        maxWorkers: 1,
        workers: 1,
      });
    } finally {
      workerChannel.unsubscribe(recordWorker);
    }
  });

  it("retires a queued agent without closing its sibling catalog worker", async () => {
    const fixture = await createFleetFixture();
    await Promise.all(
      fixture.snapshots.map((snapshot) =>
        loadPreparedModelRuntimeAuth(snapshot, { providerIds: [] }),
      ),
    );
    const marker = fixture.marker;
    const before = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
    fs.writeFileSync(`${marker}.hold`, "");
    const first = loadCompletedFullCatalog(fixture.snapshots[0]!, { refresh: true });
    let retired: ReturnType<typeof loadPreparedModelRuntimeAuth> | undefined;
    let sibling: ReturnType<typeof loadPreparedModelRuntimeAuth> | undefined;
    try {
      await expect
        .poll(() => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""))
        .not.toBe(before);
      retired = loadPreparedModelRuntimeAuth(fixture.snapshots[1]!, { providerIds: [PROVIDER_ID] });
      void retired.catch(() => undefined);
      sibling = loadPreparedModelRuntimeAuth(fixture.snapshots[2]!, { providerIds: [PROVIDER_ID] });
      void sibling.catch(() => undefined);
      await expect.poll(() => getPreparedModelCatalogWorkerPoolSnapshot().pendingTasks).toBe(3);
      await refreshPreparedModelRuntimeSnapshots(fixture.config, {
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        agentIds: new Set([fixture.agentIds[1]!]),
        pluginMetadataSnapshot: fixture.snapshots[0]!.metadataSnapshot,
      });
      fs.rmSync(`${marker}.hold`);
      await expect(retired).rejects.toThrow("superseded");
      await expect(sibling).resolves.toMatchObject({ authStore: { version: 1 } });
      await first;
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        maxWorkers: 1,
        workers: 1,
        workersCreated: 1,
      });
    } finally {
      fs.rmSync(`${marker}.hold`, { force: true });
      await Promise.allSettled([first, retired, sibling]);
    }
  });
  it.for([false, true])(
    "rotates the pinned environment after a full Gateway publication (shutdown: %s)",
    async (shutdown, { signal }) => {
      const fixture = await createFleetFixture();
      const spawned: Worker[] = [];
      let peakWorkers = 0;
      const workerChannel = channel("worker_threads");
      const recordWorker = (message: unknown) => {
        if (isRecord(message) && message.worker instanceof Worker) {
          spawned.push(message.worker);
          peakWorkers = Math.max(
            peakWorkers,
            spawned.filter((worker) => worker.threadId !== -1).length,
          );
        }
      };
      const warnings = vi.spyOn(process, "emitWarning");
      workerChannel.subscribe(recordWorker);
      try {
        await Promise.all(
          fixture.snapshots.map((snapshot) =>
            loadPreparedModelRuntimeAuth(snapshot, { providerIds: [] }),
          ),
        );
        expect(spawned).toHaveLength(1);
        const nextMarker = path.join(fixture.root, "next-environment-marker.txt");
        vi.stubEnv("OPENCLAW_WORKER_CATALOG_MARKER", nextMarker);
        const publish = () =>
          refreshPreparedModelRuntimeSnapshots(fixture.config, {
            catalogMode: "static",
            allowGatewaySubagentBinding: true,
            pluginMetadataSnapshot: fixture.snapshots[0]!.metadataSnapshot,
          });
        const replacement = () =>
          getPreparedModelRuntimeSnapshot({
            agentId: fixture.agentIds[0],
            agentDir: fixture.entries[fixture.agentIds[0]!]!.agentDir,
            config: fixture.config,
          })!;
        if (shutdown) {
          const retiring = createDeferredCore();
          const resumeTermination = createDeferredCore();
          const resumeShutdown = createDeferredCore();
          const resume = () => {
            resumeTermination.resolve();
            resumeShutdown.resolve();
          };
          signal.addEventListener("abort", resume, { once: true });
          const worker = spawned[0]!;
          const terminate = worker.terminate.bind(worker);
          const termination = vi.spyOn(worker, "terminate").mockImplementation(async () => {
            const code = await terminate();
            retiring.resolve();
            await resumeTermination.promise;
            return code;
          });
          const release = registerPreparedModelRuntimeClose(() => resumeShutdown.promise);
          let closing: Promise<void> | undefined;
          const request = publish().then(() =>
            loadPreparedModelRuntimeAuth(replacement(), { providerIds: [] }),
          );
          try {
            await Promise.race([
              retiring.promise,
              request.then(() => {
                throw new Error("replacement completed before retiring its previous worker");
              }),
            ]);
            closing = closePreparedModelRuntimeSnapshots();
            resumeTermination.resolve();
            await expect(request).rejects.toThrow("process lifetime closed");
          } finally {
            signal.removeEventListener("abort", resume);
            resume();
            await Promise.allSettled([request, closing]);
            release();
            termination.mockRestore();
          }
          await closing;
          await retirePluginCache(
            getPluginMetadataSnapshotCache(fixture.snapshots[0]!.metadataSnapshot),
          );
          await checkpoint();
          expect(spawned).toHaveLength(1);
          expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
            workers: 0,
            activeTasks: 0,
            pendingTasks: 0,
          });
        } else {
          await publish();
          await expect(
            loadPreparedModelRuntimeAuth(fixture.snapshots[0]!, { providerIds: [PROVIDER_ID] }),
          ).rejects.toThrow("superseded");
          await loadCompletedFullCatalog(replacement(), { refresh: true });
          expect(fs.readFileSync(nextMarker, "utf8")).toContain("done");
          expect(spawned).toHaveLength(2);
        }
        expect(peakWorkers).toBe(1);
        expect(
          warnings.mock.calls.filter(([warning]) =>
            String(warning).includes("Gateway catalog worker failed to retire"),
          ),
        ).toEqual([]);
      } finally {
        workerChannel.unsubscribe(recordWorker);
        warnings.mockRestore();
      }
    },
  );
  it("keeps a queued deadline local and accepts the same agent's next request", async () => {
    const fixture = await createFleetFixture();
    await Promise.all(
      fixture.snapshots.map((snapshot) =>
        loadPreparedModelRuntimeAuth(snapshot, { providerIds: [] }),
      ),
    );
    const before = fs.existsSync(fixture.marker) ? fs.readFileSync(fixture.marker, "utf8") : "";
    fs.writeFileSync(`${fixture.marker}.hold`, "");
    const first = loadCompletedFullCatalog(fixture.snapshots[0]!, { refresh: true });
    let expired: ReturnType<typeof loadPreparedModelRuntimeAuth> | undefined;
    try {
      await expect
        .poll(() => (fs.existsSync(fixture.marker) ? fs.readFileSync(fixture.marker, "utf8") : ""))
        .not.toBe(before);
      // The already-created pool owns native timers. Advance only the queued caller's outer
      // deadline while the sibling's worker and its admitted execution budget remain live.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      expired = loadPreparedModelRuntimeAuth(fixture.snapshots[1]!, { providerIds: [PROVIDER_ID] });
      void expired.catch(() => undefined);
      await vi.waitFor(() =>
        expect(getPreparedModelCatalogWorkerPoolSnapshot().pendingTasks).toBe(2),
      );
      await vi.advanceTimersByTimeAsync(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS);
      await expect(expired).rejects.toMatchObject({ name: "WorkerTaskError", code: "timeout" });
      vi.useRealTimers();
      expect(fixture.snapshots.every((snapshot) => snapshot.isCurrent())).toBe(true);
      fs.rmSync(`${fixture.marker}.hold`);
      await first;
      await expect(
        loadPreparedModelRuntimeAuth(fixture.snapshots[1]!, { providerIds: [PROVIDER_ID] }),
      ).resolves.toMatchObject({ authStore: { version: 1 } });
      await expect(
        loadPreparedModelRuntimeAuth(fixture.snapshots[2]!, { providerIds: [PROVIDER_ID] }),
      ).resolves.toMatchObject({ authStore: { version: 1 } });
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        maxWorkers: 1,
        workers: 1,
        workersCreated: 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
    } finally {
      vi.useRealTimers();
      fs.rmSync(`${fixture.marker}.hold`, { force: true });
      await Promise.allSettled([first, expired]);
    }
  });
});
