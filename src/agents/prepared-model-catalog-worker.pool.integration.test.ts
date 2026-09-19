import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { threadId, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginMetadataSnapshotCache, retirePluginCache } from "../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentAuthDiscovery from "./agent-auth-discovery.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import {
  getPreparedModelCatalogWorkerPoolSnapshot,
  PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
} from "./prepared-model-catalog-worker.js";
import {
  EXTERNAL_AUTH_PATH_ENV,
  EXTERNAL_AUTH_PROFILE_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
  createCatalogFixture,
  writeFixturePlugin,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import {
  acquirePublishedPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
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

async function createFleetFixture(onBeforePublication?: () => void, stableCatalog = false) {
  const fixture = createCatalogFixture(makeTempDir, 0);
  if (stableCatalog) {
    fs.writeFileSync(
      path.join(fixture.root, "plugin", "openclaw.plugin.json"),
      JSON.stringify({
        id: PROVIDER_ID,
        providers: [PROVIDER_ID],
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    fs.writeFileSync(
      path.join(fixture.root, "plugin", "index.cjs"),
      `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Retained catalog", auth: [],
    catalog: { async run(ctx) {
      const marker = process.env.OPENCLAW_WORKER_CATALOG_MARKER;
      fs.writeFileSync(marker + ".worker", JSON.stringify({ pid: process.pid, cwd: process.cwd(),
        threadId: require("node:worker_threads").threadId, agentDir: ctx.agentDir }));
      fs.appendFileSync(marker, "start\\n");
      const barrier = marker + ".hold";
      if (fs.existsSync(barrier)) await new Promise(resolve => {
        const check = () => {
          if (!fs.existsSync(barrier)) { fs.unwatchFile(barrier, check); resolve(); }
        };
        fs.watchFile(barrier, { interval: 10 }, check);
        check();
      });
      return { provider: { api: "openai-completions", baseUrl: "https://worker-catalog.invalid/v1",
        models: [{ id: "sqlite-model", name: "Configured model" },
          { id: "plugin-generation-v1", name: "Retained model" }] } };
    } },
  });
} };`,
    );
    saveAuthProfileStore({ version: 1, profiles: {} }, fixture.agentDir);
  }
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
    agents: {
      ...fixture.config.agents,
      ...(stableCatalog ? { defaults: { ...fixture.config.agents.defaults, models: {} } } : {}),
      entries,
    },
  } satisfies OpenClawConfig;
  for (const id of agentIds) {
    fs.mkdirSync(entries[id]!.workspace, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [`fleet:${id}`]: { type: "api_key", provider: "fleet-proof", key: `synthetic-${id}` },
          ...(stableCatalog
            ? {
                [`${PROVIDER_ID}:default`]: {
                  type: "api_key" as const,
                  provider: PROVIDER_ID,
                  key: `synthetic-catalog-${id}`,
                },
              }
            : {}),
        },
      },
      entries[id]!.agentDir,
    );
  }
  onBeforePublication?.();
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
    const spawned: Worker[] = [];
    const workerChannel = channel("worker_threads");
    const recordWorker = (message: unknown) => {
      if (isRecord(message) && message.worker instanceof Worker) {
        spawned.push(message.worker);
      }
    };
    try {
      const fixture = await createFleetFixture(() => workerChannel.subscribe(recordWorker));
      const { snapshots, agentIds } = fixture;
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
      const filename = [...captures][0]!;
      const captureRoot = filename.slice(0, filename.indexOf(`${path.sep}openclaw-plugin-build-`));
      expect(path.basename(captureRoot)).toMatch(/^openclaw-model-catalog-/);
      const inventory = () => fs.readdirSync(captureRoot).toSorted();
      const retained = inventory();
      for (const token of ["B", "C"]) {
        fs.writeFileSync(fixture.externalAuthPath, token);
        for (const snapshot of snapshots) {
          const auth = await loadPreparedModelRuntimeAuth(snapshot, { providerIds: [PROVIDER_ID] });
          expect(auth?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
            access: `v1:${token}`,
          });
          await loadCompletedFullCatalog(snapshot, { refresh: true });
        }
        expect(inventory()).toEqual(retained);
      }
      await closePreparedModelRuntimeSnapshots();
      expect(fs.existsSync(captureRoot)).toBe(false);
    } finally {
      workerChannel.unsubscribe(recordWorker);
    }
  });
  it("republishes failed catalog borrowers before replacing their source worker", async () => {
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
    try {
      const fixture = await createFleetFixture(() => workerChannel.subscribe(recordWorker));
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

  it("retains only the admitted renewal failure when queued auth observes pool closure first", async () => {
    const spawned: Worker[] = [];
    const workerChannel = channel("worker_threads");
    const recordWorker = (message: unknown) => {
      if (isRecord(message) && message.worker instanceof Worker) {
        spawned.push(message.worker);
      }
    };
    const fixture = await createFleetFixture(() => workerChannel.subscribe(recordWorker), true);
    const taskChannel = channel("openclaw.worker.task");
    const failedTasks: unknown[] = [];
    const recordFailure = (message: unknown) => {
      if (isRecord(message) && message.outcome === "failed") {
        failedTasks.push({ activeTasks: message.activeTasks, pendingTasks: message.pendingTasks });
      }
    };
    const catalogFailures: Array<{ error: Error; modelFactsChanged?: boolean }> = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "catalog-failed") {
        catalogFailures.push(event);
      }
    });
    let renewal: ReturnType<typeof loadCompletedFullCatalog> | undefined;
    let queuedAuth: ReturnType<typeof loadPreparedModelRuntimeAuth> | undefined;
    let queuedCatalog: ReturnType<typeof loadCompletedFullCatalog> | undefined;
    try {
      const accepted = await Promise.all(
        fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)),
      );
      for (const catalog of accepted) {
        expect(catalog.entries).toContainEqual(
          expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
        );
        expect(catalog.refreshFailed).toBeUndefined();
      }
      expect(spawned).toHaveLength(1);
      const acceptedAuth = accepted.map((catalog) => {
        const auth = getPreparedModelFullCatalogAuth(catalog)!;
        return { ...auth, authStore: { profiles: auth.authStore.profiles } };
      });
      const acceptedRuntime = fixture.snapshots.map((snapshot) => snapshot.readPublishedModels!());
      const worker = spawned[0]!;
      const custody = {
        pid: process.pid,
        cwd: process.cwd(),
        threadId: worker.threadId,
        agentDir: fixture.snapshots[0]!.agentDir,
      };
      expect(custody.threadId).toBeGreaterThan(0);
      const before = fs.readFileSync(fixture.marker, "utf8");
      fs.writeFileSync(`${fixture.marker}.hold`, "");
      renewal = fixture.snapshots[0]!.loadFullModelCatalog!({ refresh: true });
      void renewal.catch(() => undefined);
      await expect.poll(() => fs.readFileSync(fixture.marker, "utf8")).not.toBe(before);
      expect(JSON.parse(fs.readFileSync(`${fixture.marker}.worker`, "utf8"))).toEqual(custody);
      expect(fixture.snapshots[0]!.readFullModelCatalog!()).toBe(accepted[0]);
      queuedAuth = loadPreparedModelRuntimeAuth(fixture.snapshots[1]!, {
        providerIds: [PROVIDER_ID],
      });
      void queuedAuth.catch(() => undefined);
      queuedCatalog = fixture.snapshots[2]!.loadFullModelCatalog!({ refresh: true });
      void queuedCatalog.catch(() => undefined);
      await expect
        .poll(() => getPreparedModelCatalogWorkerPoolSnapshot())
        .toMatchObject({
          workers: 1,
          activeTasks: 1,
          pendingTasks: 2,
        });
      taskChannel.subscribe(recordFailure);
      console.info("Terminating fixture catalog worker", custody);
      await worker.terminate();
      await expect(queuedAuth).rejects.toMatchObject({
        name: "WorkerTaskError",
        code: "unavailable",
      });
      await expect(renewal).rejects.toMatchObject({ name: "WorkerTaskError", code: "unavailable" });
      await expect(queuedCatalog).rejects.toThrow("superseded");
      const originalError = await renewal.catch((error: unknown) => error);
      expect(originalError).toBe(catalogFailures[0]!.error);
      expect(catalogFailures[0]).toMatchObject({ modelFactsChanged: false });
      expect(originalError).toBe(await queuedAuth.catch((error: unknown) => error));
      expect(originalError).toMatchObject({ message: "worker exited with code 1" });
      taskChannel.unsubscribe(recordFailure);
      expect(failedTasks).toEqual([
        { activeTasks: 1, pendingTasks: 1 },
        { activeTasks: 0, pendingTasks: 0 },
      ]);
      expect(fixture.snapshots.every((snapshot) => !snapshot.isCurrent())).toBe(true);
      fs.rmSync(`${fixture.marker}.hold`);
      const replacements = fixture.agentIds.map((agentId) =>
        getPreparedModelRuntimeSnapshot({
          agentId,
          agentDir: fixture.entries[agentId]!.agentDir,
          config: fixture.config,
        })!,
      );
      for (const [index, replacement] of replacements.entries()) {
        expect(replacement).not.toBe(fixture.snapshots[index]);
        expect(replacement.isCurrent()).toBe(true);
        const retained = replacement.readFullModelCatalog!()!;
        expect(retained.entries).toEqual(accepted[index]!.entries);
        const auth = getPreparedModelFullCatalogAuth(retained)!;
        expect({ ...auth, authStore: { profiles: auth.authStore.profiles } }).toEqual(
          acceptedAuth[index],
        );
        expect(replacement.readPublishedModels!()).toEqual(acceptedRuntime[index]);
        expect(replacement.config.agents?.defaults?.model).toEqual(
          fixture.snapshots[index]!.config.agents?.defaults?.model,
        );
        expect(retained.pendingProviders).toBeUndefined();
        expect(retained.refreshFailed).toBe(index === 0 ? true : undefined);
      }
      expect(catalogFailures).toHaveLength(1);
      await expect(
        loadPreparedModelRuntimeAuth(replacements[1]!, { providerIds: [PROVIDER_ID] }),
      ).resolves.toMatchObject({ authStore: { version: 1 } });
      expect(replacements[0]!.readFullModelCatalog!()!.refreshFailed).toBe(true);
      for (const replacement of replacements.slice(1)) {
        expect(replacement.readFullModelCatalog!()!.refreshFailed).toBeUndefined();
      }
      expect(catalogFailures).toHaveLength(1);
      expect(spawned).toHaveLength(2);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workers: 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
    } finally {
      fs.rmSync(`${fixture.marker}.hold`, { force: true });
      await Promise.allSettled([renewal, queuedAuth, queuedCatalog]);
      taskChannel.unsubscribe(recordFailure);
      workerChannel.unsubscribe(recordWorker);
      unregister();
    }
  });

  it.for(["source", "credentials"])(
    "fences a pending recovery callback across %s A to B to A",
    async (identity, { signal }) => {
      const spawned: Worker[] = [];
      const workerChannel = channel("worker_threads");
      const recordWorker = (message: unknown) => {
        if (isRecord(message) && message.worker instanceof Worker) {
          spawned.push(message.worker);
        }
      };
      const fixture = await createFleetFixture(() => workerChannel.subscribe(recordWorker), true);
      const exited = createDeferredCore();
      const release = createDeferredCore();
      const resume = () => release.resolve();
      signal.addEventListener("abort", resume, { once: true });
      const failures: Error[] = [];
      const unregister = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "catalog-failed") {
          failures.push(event.error);
        }
      });
      let renewal: ReturnType<typeof loadCompletedFullCatalog> | undefined;
      let termination: MockInstance<Worker["terminate"]> | undefined;
      try {
        const original = fixture.snapshots[0]!;
        const accepted = (
          await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)))
        )[0]!;
        expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
          activeTasks: 0,
          pendingTasks: 0,
        });
        const originalStore = getPreparedModelRuntimeAuthStore(original)!;
        const agentId = fixture.agentIds[0]!;
        const current = () =>
          getPreparedModelRuntimeSnapshot({
            agentId,
            agentDir: original.agentDir,
            config: fixture.config,
          })!;
        const before = fs.readFileSync(fixture.marker, "utf8");
        fs.writeFileSync(`${fixture.marker}.hold`, "");
        renewal = original.loadFullModelCatalog!({ refresh: true });
        void renewal.catch(() => undefined);
        await expect.poll(() => fs.readFileSync(fixture.marker, "utf8")).not.toBe(before);
        const worker = spawned[0]!;
        const custody = {
          pid: process.pid,
          cwd: process.cwd(),
          threadId: worker.threadId,
          agentDir: original.agentDir,
        };
        expect(JSON.parse(fs.readFileSync(`${fixture.marker}.worker`, "utf8"))).toEqual(custody);
        expect(original.readFullModelCatalog!()).toBe(accepted);
        console.info("Terminating fixture catalog worker before identity replacement", custody);
        const terminate = worker.terminate.bind(worker);
        termination = vi.spyOn(worker, "terminate").mockImplementation(async () => {
          const result = await terminate();
          exited.resolve();
          await release.promise;
          return result;
        });
        await terminate();
        await exited.promise;
        expect(worker.threadId).toBe(-1);
        expect(failures).toEqual([]);
        for (const next of ["B", "A"]) {
          const previous = current();
          if (identity === "source") {
            const config: OpenClawConfig =
              next === "A"
                ? fixture.config
                : {
                    ...fixture.config,
                    models: {
                      providers: {
                        [PROVIDER_ID]: {
                          baseUrl: "https://replacement-catalog.invalid/v1",
                          api: "openai-completions",
                          models: [],
                        },
                      },
                    },
                  };
            await refreshPreparedModelRuntimeSnapshots(config, {
              catalogMode: "static",
              allowGatewaySubagentBinding: true,
              agentIds: new Set([agentId]),
              pluginMetadataSnapshot: original.metadataSnapshot,
            });
          } else {
            const key =
              next === "A" ? `synthetic-catalog-${agentId}` : "synthetic-catalog-account-b";
            const published = createDeferredCore();
            const stop = registerPreparedModelRuntimePublicationListener((event) => {
              const snapshot = current();
              const profile =
                snapshot &&
                getPreparedModelRuntimeAuthStore(snapshot)?.profiles[`${PROVIDER_ID}:default`];
              if (
                event.phase === "published" &&
                snapshot !== previous &&
                profile?.type === "api_key" &&
                profile.key === key
              ) {
                published.resolve();
              }
            });
            try {
              saveAuthProfileStore(
                {
                  ...originalStore,
                  profiles: {
                    ...originalStore.profiles,
                    [`${PROVIDER_ID}:default`]: { type: "api_key", provider: PROVIDER_ID, key },
                  },
                },
                original.agentDir,
              );
              await published.promise;
            } finally {
              stop();
            }
          }
          expect(previous.isCurrent()).toBe(false);
          expect(current()).not.toBe(previous);
          expect(current().isCurrent()).toBe(true);
          expect(original.isCurrent()).toBe(false);
        }
        const replacement = current();
        expect(failures).toEqual([]);
        resume();
        fs.rmSync(`${fixture.marker}.hold`);
        await expect(renewal).rejects.toMatchObject({
          name: "WorkerTaskError",
          code: "unavailable",
        });
        const recovered = await loadCompletedFullCatalog(replacement);
        expect(current()).toBe(replacement);
        expect(recovered.entries).toEqual(accepted.entries);
        expect(getPreparedModelFullCatalogAuth(recovered)?.credentials).toEqual(
          getPreparedModelFullCatalogAuth(accepted)?.credentials,
        );
        expect(recovered.refreshFailed).toBeUndefined();
        expect(failures).toEqual([]);
      } finally {
        resume();
        signal.removeEventListener("abort", resume);
        fs.rmSync(`${fixture.marker}.hold`, { force: true });
        await Promise.allSettled([renewal]);
        termination?.mockRestore();
        unregister();
        workerChannel.unsubscribe(recordWorker);
      }
    },
  );

  it.for(["shutdown", "plugin retirement"])(
    "does not report renewal failure during warm %s",
    async (reason) => {
      const fixture = await createFleetFixture(undefined, true);
      await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
      const failures: Error[] = [];
      const unregister = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "catalog-failed") {
          failures.push(event.error);
        }
      });
      const before = fs.readFileSync(fixture.marker, "utf8");
      fs.writeFileSync(`${fixture.marker}.hold`, "");
      const renewal = fixture.snapshots[0]!.loadFullModelCatalog!({ refresh: true });
      void renewal.catch(() => undefined);
      let queued: ReturnType<typeof loadCompletedFullCatalog> | undefined;
      let closing: Promise<void> | ReturnType<typeof retirePluginCache> | undefined;
      try {
        await expect.poll(() => fs.readFileSync(fixture.marker, "utf8")).not.toBe(before);
        queued = fixture.snapshots[1]!.loadFullModelCatalog!({ refresh: true });
        void queued.catch(() => undefined);
        closing =
          reason === "shutdown"
            ? closePreparedModelRuntimeSnapshots()
            : retirePluginCache(
                getPluginMetadataSnapshotCache(fixture.snapshots[0]!.metadataSnapshot),
              );
        fs.rmSync(`${fixture.marker}.hold`);
        await closing;
        await expect(renewal).rejects.toThrow();
        await expect(queued).rejects.toThrow();
        const stopped = fs.readFileSync(fixture.marker, "utf8");
        await expect(
          fixture.snapshots[2]!.loadFullModelCatalog!({ refresh: true }),
        ).rejects.toThrow();
        await checkpoint();
        expect(fs.readFileSync(fixture.marker, "utf8")).toBe(stopped);
        expect(failures).toEqual([]);
        expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
          workers: 0,
          activeTasks: 0,
          pendingTasks: 0,
        });
      } finally {
        fs.rmSync(`${fixture.marker}.hold`, { force: true });
        await Promise.allSettled([renewal, queued, closing]);
        unregister();
      }
    },
  );

  it("retires a queued agent without closing its sibling catalog worker", async () => {
    const fixture = await createFleetFixture();
    await Promise.all(
      fixture.snapshots.map((snapshot) =>
        loadPreparedModelRuntimeAuth(snapshot, { providerIds: [] }),
      ),
    );
    await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
    expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
      workers: 1,
      workersCreated: 1,
      activeTasks: 0,
      pendingTasks: 0,
    });
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
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        activeTasks: 1,
        pendingTasks: 1,
      });
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
  it("retains a shared registry while its predecessor borrower finishes during replacement", async ({
    signal,
  }) => {
    const fixture = await createFleetFixture();
    await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
    const predecessorAgentId = fixture.agentIds[0]!;
    const predecessor = await acquirePublishedPreparedModelRuntime({
      agentId: predecessorAgentId,
      agentDir: fixture.entries[predecessorAgentId]!.agentDir,
      config: fixture.config,
    });
    const selected = createDeferredCore();
    const resume = createDeferredCore();
    const release = () => resume.resolve();
    signal.addEventListener("abort", release, { once: true });
    const prepare = agentAuthDiscovery.prepareAmbientAgentCredentialsForDiscovery;
    const preparation = vi
      .spyOn(agentAuthDiscovery, "prepareAmbientAgentCredentialsForDiscovery")
      .mockImplementationOnce(async (...args) => {
        selected.resolve();
        await resume.promise;
        return await prepare(...args);
      });
    let replacement: Promise<void> | undefined;
    try {
      replacement = refreshPreparedModelRuntimeSnapshots(fixture.config, {
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        pluginMetadataSnapshot: fixture.snapshots[0]!.metadataSnapshot,
      });
      void replacement.catch(() => undefined);
      await Promise.race([
        selected.promise,
        replacement.then(() => {
          throw new Error("replacement skipped registry preparation");
        }),
      ]);
      // The successor has selected the live cached registry. Finishing its predecessor
      // must not dispose that registry while successor auth capture is still pending.
      await predecessor[Symbol.asyncDispose]();
      resume.resolve();
      await expect(replacement).resolves.toBeUndefined();
      for (const agentId of fixture.agentIds) {
        const current = getPreparedModelRuntimeSnapshot({
          agentId,
          agentDir: fixture.entries[agentId]!.agentDir,
          config: fixture.config,
        });
        expect(current?.isCurrent()).toBe(true);
        expect(
          getPreparedModelRuntimeAuthStore(current!)?.profiles[`${PROVIDER_ID}:external`],
        ).toMatchObject({ type: "oauth", access: "v1:A" });
      }
    } finally {
      release();
      signal.removeEventListener("abort", release);
      await Promise.allSettled([replacement, predecessor[Symbol.asyncDispose]()]);
      preparation.mockRestore();
    }
  });

  it("keeps replacement preparation alive when the preceding catalog finishes", async () => {
    const fixture = await createFleetFixture();
    await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
    const before = fs.readFileSync(fixture.marker, "utf8");
    fs.writeFileSync(`${fixture.marker}.hold`, "");
    const previousCatalog = fixture.snapshots[0]!.loadFullModelCatalog!({ refresh: true });
    void previousCatalog.catch(() => {});
    const preparing = createDeferredCore();
    const resume = createDeferredCore();
    const prepareCredentials = agentAuthDiscovery.prepareAmbientAgentCredentialsForDiscovery;
    const preparation = vi
      .spyOn(agentAuthDiscovery, "prepareAmbientAgentCredentialsForDiscovery")
      .mockImplementationOnce(async (options) => {
        const credentials = await prepareCredentials(options);
        preparing.resolve();
        await resume.promise;
        return credentials;
      });
    let publication: Promise<void> | undefined;
    try {
      await expect.poll(() => fs.readFileSync(fixture.marker, "utf8")).not.toBe(before);
      publication = refreshPreparedModelRuntimeSnapshots(fixture.config, {
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        pluginMetadataSnapshot: fixture.snapshots[0]!.metadataSnapshot,
      });
      void publication.catch(() => {});
      await Promise.race([
        preparing.promise,
        publication.then(() => {
          throw new Error("Publication completed before its credential preparation");
        }),
      ]);
      fs.rmSync(`${fixture.marker}.hold`);
      await expect(previousCatalog).rejects.toThrow("superseded");
      resume.resolve();
      await publication;
      const replacement = getPreparedModelRuntimeSnapshot({
        agentId: fixture.agentIds[0],
        agentDir: fixture.snapshots[0]!.agentDir,
        config: fixture.config,
      })!;
      expect(replacement).not.toBe(fixture.snapshots[0]);
      expect(replacement.isCurrent()).toBe(true);
      expect((await loadCompletedFullCatalog(replacement)).entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
      );
    } finally {
      resume.resolve();
      fs.rmSync(`${fixture.marker}.hold`, { force: true });
      await Promise.allSettled([previousCatalog, publication]);
      preparation.mockRestore();
    }
  });
  it.for([false, true])(
    "rotates the pinned environment after a full Gateway publication (shutdown: %s)",
    async (shutdown, { signal }) => {
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
      try {
        const fixture = await createFleetFixture(() => workerChannel.subscribe(recordWorker));
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
