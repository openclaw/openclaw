import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginMetadataSnapshotCache, retirePluginCache } from "../plugins/plugin-cache.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentAuthDiscovery from "./agent-auth-discovery.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import {
  getPreparedModelCatalogWorkerPoolSnapshot,
  PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
} from "./prepared-model-catalog-worker.js";
import { writeFixturePlugin, PROVIDER_ID } from "./prepared-model-catalog-worker.test-support.js";
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
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import {
  loadCompletedFullCatalog,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const runtimeWarnings = vi.hoisted((): string[] => []);
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "agents/prepared-model-runtime"
        ? {
            ...logger,
            warn: (message: string, meta?: Record<string, unknown>) => {
              runtimeWarnings.push(message);
              logger.warn(message, meta);
            },
          }
        : logger;
    },
  };
});

const { makeTempDir, observeCatalogEntry: observeEntry } = usePreparedCatalogWorkerFixtures({
  observeCatalogWork: true,
});

let receipts: FixtureReceiptChannel;
const createFleetFixture = createCatalogFleetFixture(makeTempDir, () => receipts.broadcastName);

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function observeCatalogEntry(marker: string, agentDir: string) {
  return observeEntry(receipts, { marker, agentDir });
}

function observeWorkers() {
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
  return {
    spawned,
    get peakWorkers() {
      return peakWorkers;
    },
    subscribe: () => workerChannel.subscribe(recordWorker),
    close: () => workerChannel.unsubscribe(recordWorker),
  };
}
const workerFailureWarnings = () =>
  runtimeWarnings.filter((message) => message.startsWith("model catalog worker failed"));

describe("Gateway catalog worker pool", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
  });
  it("republishes failed catalog borrowers before replacing their source worker", async () => {
    const observed = observeWorkers();
    try {
      const fixture = await createFleetFixture(observed.subscribe);
      await Promise.all(
        fixture.snapshots.map((snapshot) =>
          loadPreparedModelRuntimeAuth(snapshot, { providerIds: [PROVIDER_ID] }),
        ),
      );
      expect(observed.spawned).toHaveLength(1);
      const { workerFailures } = getPreparedModelCatalogWorkerPoolSnapshot();
      const warnings = workerFailureWarnings().length;
      writeFixturePlugin({ root: fixture.root, spinMs: 0, pluginVersion: "v2" });
      await observed.spawned[0]!.terminate();
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
      expect(observed.spawned).toHaveLength(2);
      expect(observed.peakWorkers).toBe(1);
      // The replacement pool restarts its own counters; the failure survives it.
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        maxWorkers: 1,
        workers: 1,
        workersCreated: 1,
        workerFailures: workerFailures + 1,
      });
      expect(workerFailureWarnings().slice(warnings)).toEqual([
        expect.stringMatching(
          /^model catalog worker failed; \d+ agent catalog\(s\) will be republished on a new worker \(failure \d+ since start\): .*worker exited with code 1/,
        ),
      ]);
    } finally {
      observed.close();
    }
  });

  it("logs and counts an idle catalog worker exit before a request recovers it", async () => {
    const observed = observeWorkers();
    try {
      const fixture = await createFleetFixture(observed.subscribe);
      await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
      const { workerFailures } = getPreparedModelCatalogWorkerPoolSnapshot();
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workers: 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
      const warnings = workerFailureWarnings().length;
      await observed.spawned[0]!.terminate();
      // No request is waiting; the exit is still counted and logged before recovery starts.
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workers: 0,
        workerFailures: workerFailures + 1,
      });
      expect(workerFailureWarnings().slice(warnings)).toEqual([
        expect.stringMatching(/^model catalog worker failed; .*worker exited with code 1/),
      ]);
      await expect(
        loadPreparedModelRuntimeAuth(fixture.snapshots[0]!, { providerIds: [] }),
      ).rejects.toThrow();
      // Recovery replaces the worker without counting or logging the same failure again.
      expect(getPreparedModelCatalogWorkerPoolSnapshot().workerFailures).toBe(workerFailures + 1);
      expect(workerFailureWarnings()).toHaveLength(warnings + 1);
    } finally {
      observed.close();
    }
  });

  it("retains only the admitted renewal failure when queued auth observes pool closure first", async ({
    signal,
  }) => {
    const observed = observeWorkers();
    const fixture = await createFleetFixture(observed.subscribe, true);
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
      expect(observed.spawned).toHaveLength(1);
      const acceptedAuth = accepted.map((catalog) => {
        const auth = getPreparedModelFullCatalogAuth(catalog)!;
        return { ...auth, authStore: { profiles: auth.authStore.profiles } };
      });
      const acceptedRuntime = fixture.snapshots.map((snapshot) => snapshot.readPublishedModels!());
      const worker = observed.spawned[0]!;
      const custody = {
        pid: process.pid,
        cwd: process.cwd(),
        threadId: worker.threadId,
        agentDir: fixture.snapshots[0]!.agentDir,
      };
      expect(custody.threadId).toBeGreaterThan(0);
      const entered = observeCatalogEntry(fixture.marker, fixture.snapshots[0]!.agentDir);
      fs.writeFileSync(`${fixture.marker}.hold`, "");
      // This case orders pool failure before the foreground fallback. Keep its clock
      // fixed while real worker entry and recovery run under variable host pressure.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      renewal = fixture.snapshots[0]!.loadFullModelCatalog!({ refresh: true });
      void renewal.catch(() => undefined);
      await entered(renewal, signal);
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
      vi.useRealTimers();
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
      expect(observed.spawned).toHaveLength(2);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workers: 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
    } finally {
      vi.useRealTimers();
      fs.rmSync(`${fixture.marker}.hold`, { force: true });
      await Promise.allSettled([renewal, queuedAuth, queuedCatalog]);
      taskChannel.unsubscribe(recordFailure);
      observed.close();
      unregister();
    }
  });

  it.for(["source", "credentials"])(
    "fences a pending recovery callback across %s A to B to A",
    async (identity, { signal }) => {
      const observed = observeWorkers();
      const fixture = await createFleetFixture(observed.subscribe, true);
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
        const entered = observeCatalogEntry(fixture.marker, original.agentDir);
        fs.writeFileSync(`${fixture.marker}.hold`, "");
        const foregroundDeadlines: Array<() => void> = [];
        const schedule = globalThis.setTimeout;
        const deadlineSpy = vi
          .spyOn(globalThis, "setTimeout")
          .mockImplementation((callback, ms, ...args) => {
            if (ms !== 5_000) {
              return schedule(callback, ms, ...args);
            }
            let fired = false;
            const expire = () => {
              if (fired) {
                return;
              }
              fired = true;
              clearTimeout(timer);
              callback(...args);
            };
            // Retain the native fallback so an earlier assertion cannot strand cleanup.
            const timer = schedule(expire, ms);
            foregroundDeadlines.push(expire);
            return timer;
          });
        try {
          renewal = original.loadFullModelCatalog!({ refresh: true });
        } finally {
          deadlineSpy.mockRestore();
        }
        void renewal.catch(() => undefined);
        await entered(renewal, signal);
        expect(foregroundDeadlines).toHaveLength(1);
        foregroundDeadlines[0]!();
        // The foreground deadline returns retained data while acquisition stays behind the barrier.
        await expect(renewal).resolves.toBe(accepted);
        const worker = observed.spawned[0]!;
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
        await expect(
          loadPreparedModelRuntimeAuth(original, { providerIds: [PROVIDER_ID] }),
        ).rejects.toThrow("superseded");
        // A real request on the replacement joins recovery before checking its publication.
        const auth = await loadPreparedModelRuntimeAuth(replacement, {
          providerIds: [PROVIDER_ID],
        });
        expect(auth?.authStore.profiles[`${PROVIDER_ID}:default`]).toEqual(
          originalStore.profiles[`${PROVIDER_ID}:default`],
        );
        const recovered = await loadCompletedFullCatalog(replacement);
        await expect
          .poll(() => getPreparedModelCatalogWorkerPoolSnapshot())
          .toMatchObject({
            workers: 1,
            activeTasks: 0,
            pendingTasks: 0,
          });
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
        observed.close();
      }
    },
  );

  it.for(["shutdown", "plugin retirement"])(
    "does not report renewal failure during warm %s",
    async (reason, { signal }) => {
      const fixture = await createFleetFixture(undefined, true);
      await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
      const failures: Error[] = [];
      const unregister = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "catalog-failed") {
          failures.push(event.error);
        }
      });
      const entered = observeCatalogEntry(fixture.marker, fixture.snapshots[0]!.agentDir);
      const { workerFailures } = getPreparedModelCatalogWorkerPoolSnapshot();
      const warnings = workerFailureWarnings().length;
      fs.writeFileSync(`${fixture.marker}.hold`, "");
      const renewal = fixture.snapshots[0]!.loadFullModelCatalog!({ refresh: true });
      void renewal.catch(() => undefined);
      let queued: ReturnType<typeof loadCompletedFullCatalog> | undefined;
      let closing: Promise<void> | ReturnType<typeof retirePluginCache> | undefined;
      try {
        await entered(renewal, signal);
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
          workerFailures,
        });
        expect(workerFailureWarnings()).toHaveLength(warnings);
      } finally {
        fs.rmSync(`${fixture.marker}.hold`, { force: true });
        await Promise.allSettled([renewal, queued, closing]);
        unregister();
      }
    },
  );

  it("retires a queued agent without closing its sibling catalog worker", async ({ signal }) => {
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
    const entered = observeCatalogEntry(marker, fixture.snapshots[0]!.agentDir);
    fs.writeFileSync(`${marker}.hold`, "");
    const first = loadCompletedFullCatalog(fixture.snapshots[0]!, { refresh: true });
    let retired: ReturnType<typeof loadPreparedModelRuntimeAuth> | undefined;
    let sibling: ReturnType<typeof loadPreparedModelRuntimeAuth> | undefined;
    try {
      await entered(first, signal);
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
  it.for(["borrower", "catalog"] as const)(
    "keeps replacement preparation alive when its predecessor %s finishes",
    async (predecessorKind, { signal }) => {
      const fixture = await createFleetFixture();
      await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
      const previous = fixture.snapshots[0]!;
      const predecessor =
        predecessorKind === "borrower"
          ? await acquirePublishedPreparedModelRuntime({
              agentId: fixture.agentIds[0]!,
              agentDir: previous.agentDir,
              config: fixture.config,
            })
          : undefined;
      const entered =
        predecessorKind === "catalog"
          ? observeCatalogEntry(fixture.marker, previous.agentDir)
          : undefined;
      let previousCatalog: ReturnType<typeof loadCompletedFullCatalog> | undefined;
      if (predecessorKind === "catalog") {
        fs.writeFileSync(`${fixture.marker}.hold`, "");
        previousCatalog = previous.loadFullModelCatalog!({ refresh: true });
        void previousCatalog.catch(() => {});
      }
      const preparing = createDeferredCore();
      const resume = createDeferredCore();
      const release = () => resume.resolve();
      signal.addEventListener("abort", release, { once: true });
      const prepare = agentAuthDiscovery.prepareAmbientAgentCredentialsForDiscovery;
      const preparation = vi
        .spyOn(agentAuthDiscovery, "prepareAmbientAgentCredentialsForDiscovery")
        .mockImplementationOnce(async (...args) => {
          if (predecessorKind === "catalog") {
            const credentials = await prepare(...args);
            preparing.resolve();
            await resume.promise;
            return credentials;
          }
          preparing.resolve();
          await resume.promise;
          return await prepare(...args);
        });
      let publication: Promise<void> | undefined;
      try {
        if (previousCatalog) {
          await entered!(previousCatalog, signal);
        }
        publication = refreshPreparedModelRuntimeSnapshots(fixture.config, {
          catalogMode: "static",
          allowGatewaySubagentBinding: true,
          pluginMetadataSnapshot: previous.metadataSnapshot,
        });
        void publication.catch(() => {});
        await Promise.race([
          preparing.promise,
          publication.then(() => {
            throw new Error("Publication completed before its credential preparation");
          }),
        ]);
        if (previousCatalog) {
          fs.rmSync(`${fixture.marker}.hold`);
          await expect(previousCatalog).rejects.toThrow("superseded");
        } else {
          // The successor selected this registry before capturing its credentials.
          await predecessor?.[Symbol.asyncDispose]();
        }
        resume.resolve();
        await expect(publication).resolves.toBeUndefined();
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
        if (previousCatalog) {
          const replacement = getPreparedModelRuntimeSnapshot({
            agentId: fixture.agentIds[0],
            agentDir: previous.agentDir,
            config: fixture.config,
          })!;
          expect(replacement).not.toBe(previous);
          expect((await loadCompletedFullCatalog(replacement)).entries).toContainEqual(
            expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
          );
        }
      } finally {
        release();
        signal.removeEventListener("abort", release);
        fs.rmSync(`${fixture.marker}.hold`, { force: true });
        await Promise.allSettled([
          previousCatalog,
          publication,
          predecessor?.[Symbol.asyncDispose](),
        ]);
        preparation.mockRestore();
      }
    },
  );
  it.for([false, true])(
    "rotates the pinned environment after a full Gateway publication (shutdown: %s)",
    async (shutdown, { signal }) => {
      const observed = observeWorkers();
      const warnings = vi.spyOn(process, "emitWarning");
      try {
        const fixture = await createFleetFixture(observed.subscribe);
        await Promise.all(
          fixture.snapshots.map((snapshot) =>
            loadPreparedModelRuntimeAuth(snapshot, { providerIds: [] }),
          ),
        );
        expect(observed.spawned).toHaveLength(1);
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
          const worker = observed.spawned[0]!;
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
          expect(observed.spawned).toHaveLength(1);
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
          expect(observed.spawned).toHaveLength(2);
        }
        expect(observed.peakWorkers).toBe(1);
        expect(
          warnings.mock.calls.filter(([warning]) =>
            String(warning).includes("Gateway catalog worker failed to retire"),
          ),
        ).toEqual([]);
      } finally {
        observed.close();
        warnings.mockRestore();
      }
    },
  );
  it("keeps a queued deadline local and accepts the same agent's next request", async ({
    signal,
  }) => {
    const fixture = await createFleetFixture();
    await Promise.all(
      fixture.snapshots.map((snapshot) =>
        loadPreparedModelRuntimeAuth(snapshot, { providerIds: [] }),
      ),
    );
    const entered = observeCatalogEntry(fixture.marker, fixture.snapshots[0]!.agentDir);
    fs.writeFileSync(`${fixture.marker}.hold`, "");
    const first = loadCompletedFullCatalog(fixture.snapshots[0]!, { refresh: true });
    let expired: ReturnType<typeof loadPreparedModelRuntimeAuth> | undefined;
    let duplicate: ReturnType<typeof loadPreparedModelRuntimeAuth> | undefined;
    try {
      await entered(first, signal);
      // The already-created pool owns native timers. Advance only the queued caller's outer
      // deadline while the sibling's worker and its admitted execution budget remain live.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      expired = loadPreparedModelRuntimeAuth(fixture.snapshots[1]!, { providerIds: [PROVIDER_ID] });
      void expired.catch(() => undefined);
      duplicate = loadPreparedModelRuntimeAuth(fixture.snapshots[1]!, {
        providerIds: [PROVIDER_ID, PROVIDER_ID],
        profileIds: [],
      });
      void duplicate.catch(() => undefined);
      await vi.waitFor(() =>
        expect(getPreparedModelCatalogWorkerPoolSnapshot().pendingTasks).toBe(2),
      );
      await vi.advanceTimersByTimeAsync(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS);
      await expect(expired).rejects.toMatchObject({ name: "WorkerTaskError", code: "timeout" });
      await expect(duplicate).rejects.toBe(await expired.catch((error: unknown) => error));
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
      await Promise.allSettled([first, expired, duplicate]);
    }
  });
});
