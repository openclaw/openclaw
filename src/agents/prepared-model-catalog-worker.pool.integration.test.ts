import fs from "node:fs";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { getPluginMetadataSnapshotCache, retirePluginCache } from "../plugins/plugin-cache.js";
import { createDeferredCore } from "../shared/deferred.js";
import { applySkillEnvOverridesFromSnapshot } from "../skills/runtime/env-overrides.js";
import * as agentAuthDiscovery from "./agent-auth-discovery.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { configFor } from "./model-auth.fixtures.test-support.js";
import { PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS } from "./model-catalog-timeouts.js";
import { getPreparedModelCatalogWorkerPoolSnapshot } from "./prepared-model-catalog-worker.js";
import {
  writeFixturePlugin,
  PROVIDER_ID,
  pendingCatalogWork,
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

const {
  makeTempDir,
  observeCatalogEntry: observeEntry,
  observeWorkers,
} = usePreparedCatalogWorkerFixtures({ observeCatalogWork: true });

let receipts: FixtureReceiptChannel;
const createFleetFixture = createCatalogFleetFixture(makeTempDir, () => receipts.broadcastName);
type Fleet = Awaited<ReturnType<typeof createFleetFixture>>;
type Snapshot = Fleet["snapshots"][number];

function currentRuntime(fixture: Fleet, index = 0) {
  const agentId = fixture.agentIds[index]!;
  return getPreparedModelRuntimeSnapshot({
    agentId,
    agentDir: fixture.entries[agentId]!.agentDir,
    config: fixture.config,
  })!;
}

function refreshFleet(
  fixture: Fleet,
  agentIds?: Set<string>,
  config: OpenClawConfig = fixture.config,
) {
  return refreshPreparedModelRuntimeSnapshots(config, {
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
    agentIds,
    pluginMetadataSnapshot: fixture.snapshots[0]!.metadataSnapshot,
  });
}

function loadFleetCatalogs(fixture: Fleet) {
  return Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
}

function loadFleetAuth(fixture: Fleet, providerIds: string[] = []) {
  return Promise.all(fixture.snapshots.map((snapshot) => loadAuth(snapshot, providerIds)));
}

function loadAuth(snapshot: Snapshot, providerIds = [PROVIDER_ID]) {
  return loadPreparedModelRuntimeAuth(snapshot, { providerIds });
}

function expectAuth(snapshot: Snapshot) {
  return expect(loadAuth(snapshot)).resolves.toMatchObject({ authStore: { version: 1 } });
}

function renew(snapshot: Snapshot) {
  return snapshot.loadFullModelCatalog!({ refresh: true });
}

function retireFleet(fixture: Fleet) {
  return retirePluginCache(getPluginMetadataSnapshotCache(fixture.snapshots[0]!.metadataSnapshot));
}

function holdFleet(fixture: Fleet, index = 0) {
  const entered = observeCatalogEntry(fixture.marker, fixture.snapshots[index]!.agentDir);
  fs.writeFileSync(`${fixture.marker}.hold`, "");
  return {
    ...pendingCatalogWork(`${fixture.marker}.hold`),
    entered,
    release: () => fs.rmSync(`${fixture.marker}.hold`),
  };
}

function observeFailures() {
  const failures: Array<{ phase: "catalog-failed"; modelFactsChanged?: boolean }> = [];
  const unregister = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "catalog-failed") {
      failures.push(event);
    }
  });
  return { failures, unregister };
}

function expectPool(state: Partial<ReturnType<typeof getPreparedModelCatalogWorkerPoolSnapshot>>) {
  expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject(state);
}

function expectGeneration(
  catalog: Awaited<ReturnType<typeof loadCompletedFullCatalog>>,
  version = "v1",
) {
  expect(catalog.entries).toContainEqual(
    expect.objectContaining({ provider: PROVIDER_ID, id: `plugin-generation-${version}` }),
  );
}

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function observeCatalogEntry(marker: string, agentDir: string) {
  return observeEntry(receipts, { marker, agentDir });
}

const workerFailureWarnings = () =>
  runtimeWarnings.filter((message) => message.startsWith("model catalog worker failed"));

describe("Gateway catalog worker pool", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
  });
  it("keeps Gateway catalogs available across temporary skill environments", async () => {
    const observed = observeWorkers();
    const fixture = await createFleetFixture(observed.subscribe, true, { agentCount: 2 });
    await loadFleetAuth(fixture, [PROVIDER_ID]);
    const agentId = fixture.agentIds[0]!;
    const sibling = fixture.snapshots[1]!;
    const skillKey = "catalog-env-fixture";
    const envKey = "OPENCLAW_CATALOG_SKILL_FIXTURE";
    vi.stubEnv(envKey, undefined);
    const refresh = async () => {
      await refreshFleet(fixture, new Set([agentId]));
      const current = currentRuntime(fixture);
      await expectAuth(current);
      await loadCompletedFullCatalog(current);
      const catalog = await loadGatewayModelCatalogSnapshot({
        agentId,
        agentDir: current.agentDir,
        workspaceDir: fixture.entries[agentId]!.workspace,
        getConfig: () => fixture.config,
        readOnly: false,
        refreshFullCatalog: true,
      });
      expectGeneration(catalog);
      expect(sibling.isCurrent()).toBe(true);
    };
    for (const value of ["first-turn", "second-turn"]) {
      const restore = applySkillEnvOverridesFromSnapshot({
        snapshot: { prompt: "", skills: [{ name: skillKey }] },
        config: { skills: { entries: { [skillKey]: { env: { [envKey]: value } } } } },
      });
      try {
        await refresh();
        expect(process.env[envKey]).toBe(value);
      } finally {
        restore();
      }
      await refresh();
    }
    expect(observed.spawned).toHaveLength(1);
  });
  it("republishes failed catalog borrowers before replacing their source worker", async () => {
    const observed = observeWorkers();
    const fixture = await createFleetFixture(observed.subscribe);
    await loadFleetCatalogs(fixture);
    const { workerFailures } = getPreparedModelCatalogWorkerPoolSnapshot();
    const warnings = workerFailureWarnings().length;
    writeFixturePlugin({ root: fixture.root, spinMs: 0, pluginVersion: "v2" });
    expectPool({ activeTasks: 0, pendingTasks: 0 });
    await observed.spawned[0]!.terminate();
    expectPool({ workers: 0, workerFailures: workerFailures + 1 });
    await expect(loadAuth(fixture.snapshots[0]!, [])).rejects.toThrow();
    expect(fixture.snapshots.every((snapshot) => !snapshot.isCurrent())).toBe(true);
    const replacement = currentRuntime(fixture);
    expect(replacement).not.toBe(fixture.snapshots[0]);
    const catalog = await loadCompletedFullCatalog(replacement, { refresh: true });
    expectGeneration(catalog, "v2");
    expect(observed.spawned).toHaveLength(2);
    expect(observed.peakWorkers).toBe(1);
    // The replacement pool restarts its own counters; the failure survives it.
    expectPool({ workerFailures: workerFailures + 1 });
    expect(workerFailureWarnings().slice(warnings)).toEqual([
      expect.stringContaining("worker exited with code 1"),
    ]);
  });

  it("retains only the admitted renewal failure when queued auth observes pool closure first", async ({
    signal,
  }) => {
    const observed = observeWorkers();
    const fixture = await createFleetFixture(observed.subscribe, true);
    const [original, queued, sibling] = fixture.snapshots;
    const { failures: catalogFailures, unregister } = observeFailures();
    const work = pendingCatalogWork(`${fixture.marker}.hold`);
    try {
      const accepted = await loadFleetCatalogs(fixture);
      const acceptedAuth = accepted.map((catalog) => {
        const auth = getPreparedModelFullCatalogAuth(catalog)!;
        return { ...auth, authStore: { profiles: auth.authStore.profiles } };
      });
      const acceptedRuntime = fixture.snapshots.map((snapshot) => snapshot.readPublishedModels!());
      const worker = observed.spawned[0]!;
      const entered = observeCatalogEntry(fixture.marker, original!.agentDir);
      fs.writeFileSync(`${fixture.marker}.hold`, "");
      // This case orders pool failure before the foreground fallback. Keep its clock
      // fixed while real worker entry and recovery run under variable host pressure.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const renewal = work.track(renew(original!));
      await entered(renewal, signal);
      expect(original!.readFullModelCatalog!()).toBe(accepted[0]);
      const queuedAuth = work.track(loadAuth(queued!));
      const queuedCatalog = work.track(renew(sibling!));
      await expect
        .poll(() => getPreparedModelCatalogWorkerPoolSnapshot())
        .toMatchObject({ workers: 1, activeTasks: 1, pendingTasks: 2 });
      await worker.terminate();
      await expect(queuedAuth).rejects.toMatchObject({
        name: "WorkerTaskError",
        code: "unavailable",
      });
      await expect(renewal).rejects.toMatchObject({ name: "WorkerTaskError", code: "unavailable" });
      await expect(queuedCatalog).rejects.toThrow("superseded");
      vi.useRealTimers();
      const originalError = await renewal.catch((error: unknown) => error);
      expect(catalogFailures[0]).toMatchObject({ modelFactsChanged: false });
      expect(originalError).toBe(await queuedAuth.catch((error: unknown) => error));
      expect(fixture.snapshots.every((snapshot) => !snapshot.isCurrent())).toBe(true);
      fs.rmSync(`${fixture.marker}.hold`);
      const replacements = fixture.agentIds.map((_, index) => currentRuntime(fixture, index));
      for (const [index, replacement] of replacements.entries()) {
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
      await expectAuth(replacements[1]!);
      expect(replacements[0]!.readFullModelCatalog!()!.refreshFailed).toBe(true);
      for (const replacement of replacements.slice(1)) {
        expect(replacement.readFullModelCatalog!()!.refreshFailed).toBeUndefined();
      }
      expect(catalogFailures).toHaveLength(1);
      expect(observed.spawned).toHaveLength(2);
      expectPool({ workers: 1, activeTasks: 0, pendingTasks: 0 });
    } finally {
      vi.useRealTimers();
      await work[Symbol.asyncDispose]();
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
      const { failures, unregister } = observeFailures();
      let renewal: ReturnType<typeof loadCompletedFullCatalog> | undefined;
      let restoreTermination: (() => void) | undefined;
      try {
        const original = fixture.snapshots[0]!;
        const accepted = (await loadFleetCatalogs(fixture))[0]!;
        expectPool({ activeTasks: 0, pendingTasks: 0 });
        const originalStore = getPreparedModelRuntimeAuthStore(original)!;
        const agentId = fixture.agentIds[0]!;
        const current = () => currentRuntime(fixture);
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
          renewal = renew(original);
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
        expect(original.readFullModelCatalog!()).toBe(accepted);
        const terminate = worker.terminate.bind(worker);
        const termination = vi.spyOn(worker, "terminate").mockImplementation(async () => {
          const result = await terminate();
          exited.resolve();
          await release.promise;
          return result;
        });
        restoreTermination = () => termination.mockRestore();
        await terminate();
        await exited.promise;
        expect(worker.threadId).toBe(-1);
        for (const next of ["B", "A"]) {
          const previous = current();
          if (identity === "source") {
            const config: OpenClawConfig =
              next === "A"
                ? fixture.config
                : {
                    ...fixture.config,
                    ...configFor(PROVIDER_ID, "https://replacement-catalog.invalid/v1", {
                      api: "openai-completions",
                    }),
                  };
            await refreshFleet(fixture, new Set([agentId]), config);
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
          expect(current().isCurrent()).toBe(true);
          expect(original.isCurrent()).toBe(false);
        }
        const replacement = current();
        resume();
        fs.rmSync(`${fixture.marker}.hold`);
        await expect(loadAuth(original)).rejects.toThrow("superseded");
        // A real request on the replacement joins recovery before checking its publication.
        const auth = await loadAuth(replacement);
        expect(auth?.authStore.profiles[`${PROVIDER_ID}:default`]).toEqual(
          originalStore.profiles[`${PROVIDER_ID}:default`],
        );
        const recovered = await loadCompletedFullCatalog(replacement);
        await expect
          .poll(() => getPreparedModelCatalogWorkerPoolSnapshot())
          .toMatchObject({ workers: 1, activeTasks: 0, pendingTasks: 0 });
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
        restoreTermination?.();
        unregister();
      }
    },
  );

  it("closes automatic catalog discovery without reporting a refresh failure", async ({
    signal,
  }) => {
    const observed = observeWorkers();
    const warnings = runtimeWarnings.length;
    let marker: string | undefined;
    let discovery: ReturnType<typeof loadCompletedFullCatalog> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const fixture = await createFleetFixture(
        (input) => {
          marker = input.marker;
          observed.subscribe();
          fs.writeFileSync(`${marker}.hold`, "");
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        },
        true,
        { agentCount: 1 },
      );
      await withinTest(receipts.waitFor(fixture.marker, "start"), signal);
      const original = fixture.snapshots[0]!;
      // Join automatic discovery so its detached warning handler settles before inspection.
      discovery = original.loadFullModelCatalog!({ changedOnly: true });
      void discovery.catch(() => undefined);
      const { workerFailures } = getPreparedModelCatalogWorkerPoolSnapshot();
      expect(observed.spawned).toHaveLength(1);
      expectPool({ workers: 1, activeTasks: 1, pendingTasks: 1 });

      closing = closePreparedModelRuntimeSnapshots();
      await withinTest(closing, signal);
      await expect(withinTest(discovery, signal)).rejects.toThrow(
        "prepared model runtime process lifetime closed",
      );

      expect(original.isCurrent()).toBe(false);
      expect(observed.spawned[0]!.threadId).toBe(-1);
      expectPool({ workers: 0, activeTasks: 0, pendingTasks: 0, workerFailures });
      expect(runtimeWarnings.slice(warnings)).toEqual([]);
    } finally {
      vi.useRealTimers();
      if (marker) {
        fs.rmSync(`${marker}.hold`, { force: true });
      }
      closing ??= closePreparedModelRuntimeSnapshots();
      await Promise.allSettled([discovery, closing]);
    }
  });

  it.for(["shutdown", "plugin retirement"])(
    "does not report renewal failure during warm %s",
    async (reason, { signal }) => {
      const fixture = await createFleetFixture(undefined, true);
      await loadFleetCatalogs(fixture);
      const { failures, unregister } = observeFailures();
      const { workerFailures } = getPreparedModelCatalogWorkerPoolSnapshot();
      const warnings = workerFailureWarnings().length;
      const work = holdFleet(fixture);
      const renewal = work.track(renew(fixture.snapshots[0]!));
      try {
        await work.entered(renewal, signal);
        const queued = work.track(renew(fixture.snapshots[1]!));
        const closing =
          reason === "shutdown"
            ? work.track(closePreparedModelRuntimeSnapshots())
            : work.track(retireFleet(fixture));
        work.release();
        await closing;
        await expect(renewal).rejects.toThrow();
        await expect(queued).rejects.toThrow();
        const stopped = fs.readFileSync(fixture.marker, "utf8");
        await expect(renew(fixture.snapshots[2]!)).rejects.toThrow();
        await checkpoint();
        expect(fs.readFileSync(fixture.marker, "utf8")).toBe(stopped);
        expect(failures).toEqual([]);
        expectPool({ workers: 0, activeTasks: 0, pendingTasks: 0, workerFailures });
        expect(workerFailureWarnings()).toHaveLength(warnings);
      } finally {
        await work[Symbol.asyncDispose]();
        unregister();
      }
    },
  );

  it("retires a queued agent without closing its sibling catalog worker", async ({ signal }) => {
    const fixture = await createFleetFixture();
    await loadFleetAuth(fixture);
    await loadFleetCatalogs(fixture);
    expectPool({ workers: 1, workersCreated: 1, activeTasks: 0, pendingTasks: 0 });
    await using work = holdFleet(fixture);
    const first = work.track(loadCompletedFullCatalog(fixture.snapshots[0]!, { refresh: true }));
    await work.entered(first, signal);
    expectPool({ activeTasks: 1, pendingTasks: 1 });
    const retired = work.track(loadAuth(fixture.snapshots[1]!));
    const sibling = work.track(loadAuth(fixture.snapshots[2]!));
    await expect.poll(() => getPreparedModelCatalogWorkerPoolSnapshot().pendingTasks).toBe(3);
    await refreshFleet(fixture, new Set([fixture.agentIds[1]!]));
    work.release();
    await expect(retired).rejects.toThrow("superseded");
    await expect(sibling).resolves.toMatchObject({ authStore: { version: 1 } });
    await first;
    expectPool({ maxWorkers: 1, workers: 1, workersCreated: 1 });
  });
  it.for(["borrower", "catalog"] as const)(
    "keeps replacement preparation alive when its predecessor %s finishes",
    async (predecessorKind, { signal }) => {
      const fixture = await createFleetFixture();
      await loadFleetCatalogs(fixture);
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
        previousCatalog = renew(previous);
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
        publication = refreshFleet(fixture);
        void publication.catch(() => {});
        await awaitGateBeforeSettlement(
          preparing.promise,
          publication,
          "Publication completed before its credential preparation",
        );
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
          const current = currentRuntime(fixture, fixture.agentIds.indexOf(agentId));
          expect(current?.isCurrent()).toBe(true);
          expect(
            getPreparedModelRuntimeAuthStore(current!)?.profiles[`${PROVIDER_ID}:external`],
          ).toMatchObject({ type: "oauth", access: "v1:A" });
        }
        if (previousCatalog) {
          const replacement = currentRuntime(fixture);
          expect(replacement).not.toBe(previous);
          expectGeneration(await loadCompletedFullCatalog(replacement));
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
      using warnings = vi.spyOn(process, "emitWarning");

      const fixture = await createFleetFixture(observed.subscribe);
      await loadFleetAuth(fixture);
      expect(observed.spawned).toHaveLength(1);
      const nextMarker = path.join(fixture.root, "next-environment-marker.txt");
      vi.stubEnv("OPENCLAW_WORKER_CATALOG_MARKER", nextMarker);
      const publish = () => refreshFleet(fixture);
      const replacement = () => currentRuntime(fixture);
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
        const request = publish().then(() => loadAuth(replacement(), []));
        try {
          await awaitGateBeforeSettlement(
            retiring.promise,
            request,
            "replacement completed before retiring its previous worker",
          );
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
        await retireFleet(fixture);
        await checkpoint();
        expect(observed.spawned).toHaveLength(1);
        expectPool({ workers: 0, activeTasks: 0, pendingTasks: 0 });
      } else {
        await publish();
        await expect(loadAuth(fixture.snapshots[0]!)).rejects.toThrow("superseded");
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
    },
  );
  it("keeps a queued deadline local and accepts the same agent's next request", async ({
    signal,
  }) => {
    const fixture = await createFleetFixture();
    // Startup discovery must finish before the pool is expected to drain.
    await loadFleetCatalogs(fixture);
    await loadFleetAuth(fixture);
    const work = holdFleet(fixture);
    const first = work.track(loadCompletedFullCatalog(fixture.snapshots[0]!, { refresh: true }));
    try {
      await work.entered(first, signal);
      // The already-created pool owns native timers. Advance only the queued caller's outer
      // deadline while the sibling's worker and its admitted execution budget remain live.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const expired = work.track(loadAuth(fixture.snapshots[1]!));
      const duplicate = work.track(
        loadPreparedModelRuntimeAuth(fixture.snapshots[1]!, {
          providerIds: [PROVIDER_ID, PROVIDER_ID],
          profileIds: [],
        }),
      );
      await vi.waitFor(() =>
        expect(getPreparedModelCatalogWorkerPoolSnapshot().pendingTasks).toBe(2),
      );
      await vi.advanceTimersByTimeAsync(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS);
      await expect(expired).rejects.toMatchObject({ name: "WorkerTaskError", code: "timeout" });
      await expect(duplicate).rejects.toBe(await expired.catch((error: unknown) => error));
      vi.useRealTimers();
      expect(fixture.snapshots.every((snapshot) => snapshot.isCurrent())).toBe(true);
      work.release();
      await first;
      await expectAuth(fixture.snapshots[1]!);
      await expectAuth(fixture.snapshots[2]!);
      expectPool({ maxWorkers: 1, workers: 1, workersCreated: 1, activeTasks: 0, pendingTasks: 0 });
    } finally {
      vi.useRealTimers();
      await work[Symbol.asyncDispose]();
    }
  });
});
