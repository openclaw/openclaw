import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { threadId, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepPluginSourceCapturesForTest } from "../plugins/plugin-source-capture-directory.test-support.js";
import { getPreparedModelCatalogWorkerPoolSnapshot } from "./prepared-model-catalog-worker.js";
import {
  EXTERNAL_AUTH_PROFILE_ID,
  writeFixturePlugin,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import {
  getPreparedModelFullCatalogAuth,
  loadPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { readCatalogCaptureFootprint } from "./test-helpers/catalog-capture-footprint.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import {
  loadCompletedFullCatalog,
  readCatalogDiscoveryCaptures,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
const createFleetFixture = createCatalogFleetFixture(makeTempDir);

describe("Gateway catalog worker captures", () => {
  beforeEach(() => vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-")));
  it("reuses one Gateway catalog worker and source graph across agent publications", async () => {
    const spawned: Worker[] = [];
    const workerChannel = channel("worker_threads");
    const recordWorker = (message: unknown) => {
      if (isRecord(message) && message.worker instanceof Worker) {
        spawned.push(message.worker);
      }
    };
    try {
      const secondaryId = "worker-catalog-secondary";
      const fixture = await createFleetFixture((seed) => {
        const original = path.join(seed.root, "plugin");
        const secondary = path.join(seed.root, "secondary-plugin");
        fs.mkdirSync(secondary);
        for (const name of fs.readdirSync(original)) {
          fs.writeFileSync(
            path.join(secondary, name),
            fs.readFileSync(path.join(original, name), "utf8").replaceAll(PROVIDER_ID, secondaryId),
          );
        }
        for (const directory of [original, secondary]) {
          fs.writeFileSync(path.join(directory, "payload.bin"), Buffer.alloc(1024 * 1024, 1));
        }
        seed.config.plugins.allow.push(secondaryId);
        seed.config.plugins.load.paths.push(path.join(secondary, "index.cjs"));
        Object.assign(seed.config.plugins.entries, { [secondaryId]: { enabled: true } });
        Object.assign(seed.config.agents.defaults.models, {
          [`${secondaryId}/sqlite-model`]: { agentRuntime: { id: `${secondaryId}-harness` } },
        });
        workerChannel.subscribe(recordWorker);
      });
      const { snapshots, agentIds } = fixture;
      await loadCompletedFullCatalog(snapshots[0]!);
      const initialCaptures = new Set(
        readCatalogDiscoveryCaptures(fixture.root)
          .filter((capture) => capture.threadId !== threadId)
          .map((capture) => capture.filename),
      );
      expect(initialCaptures.size).toBe(2);
      const capturedRuntimeSources = () =>
        new Set(
          fs
            .readFileSync(path.join(fixture.root, "runtime-artifact-paths.txt"), "utf8")
            .split("\n")
            .filter(Boolean),
        );
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
        expect(catalog.entries).toEqual(
          expect.arrayContaining(
            [PROVIDER_ID, secondaryId].map((provider) =>
              expect.objectContaining({ provider, id: "plugin-generation-v1" }),
            ),
          ),
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
      expect(capturedRuntimeSources().size).toBe(2);
      await Promise.all(
        snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot, { refresh: true })),
      );
      expect(capturedRuntimeSources().size).toBe(2);
      const filename = [...captures][0]!;
      const captureRoot = filename.slice(0, filename.indexOf(`${path.sep}openclaw-plugin-build-`));
      expect(path.basename(captureRoot)).toMatch(/^openclaw-model-catalog-/);
      const instanceRoot = path.dirname(path.dirname(captureRoot));
      expect(path.dirname(instanceRoot)).toBe(
        path.join(fixture.env.OPENCLAW_STATE_DIR!, "tmp", "plugin-captures"),
      );
      expect(fs.existsSync(path.join(instanceRoot, "owner.sqlite"))).toBe(true);
      const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
      fs.utimesSync(instanceRoot, old, old);
      await sweepPluginSourceCapturesForTest(fixture.env.OPENCLAW_STATE_DIR!);
      expect(fs.existsSync(filename)).toBe(true);
      const inventory = () => fs.readdirSync(captureRoot).toSorted();
      const retained = inventory();
      const footprint = () => readCatalogCaptureFootprint(captureRoot);
      const initialFootprint = footprint();
      console.info(
        "Catalog capture footprint",
        JSON.stringify({ phase: "loaded", ...initialFootprint }),
      );
      expect(initialFootprint.captures).toHaveLength(2);
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
      expect(footprint()).toEqual(initialFootprint);
      console.info(
        "Catalog capture footprint",
        JSON.stringify({ phase: "refreshed", ...footprint() }),
      );
      await closePreparedModelRuntimeSnapshots();
      expect(fs.existsSync(captureRoot)).toBe(false);
      console.info(
        "Catalog capture footprint",
        JSON.stringify({ phase: "retired", captures: 0, bytes: 0, allocatedBytes: 0 }),
      );
    } finally {
      workerChannel.unsubscribe(recordWorker);
    }
  });
});
