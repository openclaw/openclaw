import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { threadId, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepPluginSourceCapturesForTest } from "../plugins/plugin-source-capture-directory.test-support.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
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
    const nativeId = "unselected-native-fixture";
    const setupId = "unrelated-setup-fixture";
    let observations = "";
    try {
      const secondaryId = "worker-catalog-secondary";
      const fixture = await createFleetFixture((seed) => {
        observations = path.join(seed.root, "registration-observations.jsonl");
        fs.writeFileSync(observations, "");
        const observe = (event: string) =>
          `require("node:fs").appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ event: ${JSON.stringify(event)}, threadId: require("node:worker_threads").threadId }) + "\\n");`;
        const nativeDir = path.join(seed.root, nativeId);
        fs.mkdirSync(nativeDir);
        fs.writeFileSync(
          path.join(nativeDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: nativeId,
            activation: { onAgentHarnesses: [nativeId] },
            configSchema: { type: "object", additionalProperties: false },
          }),
        );
        fs.writeFileSync(
          path.join(nativeDir, "index.cjs"),
          `
module.exports = { id: ${JSON.stringify(nativeId)}, register(api) {
  ${observe("native-register")}
  api.registerAgentHarness({
    id: ${JSON.stringify(nativeId)}, label: "Unselected native owner", authBootstrap: "harness",
    supports: () => ({ supported: true }), runAttempt: async () => ({ ok: false, error: "unused" }),
    loadModelCatalog: async () => {
      ${observe("native-catalog")}
      return [{ provider: ${JSON.stringify(PROVIDER_ID)}, id: "unselected-native-model",
        name: "Native model", nativeRuntime: ${JSON.stringify(nativeId)} }];
    },
  });
} };`,
        );
        const setupDir = path.join(seed.root, setupId);
        fs.mkdirSync(setupDir);
        fs.writeFileSync(
          path.join(setupDir, "package.json"),
          JSON.stringify({
            name: setupId,
            version: "1.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"], setupEntry: "./setup-api.cjs" },
          }),
        );
        fs.writeFileSync(
          path.join(setupDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: setupId,
            setup: { requiresRuntime: true },
            configSchema: { type: "object", properties: { configured: { type: "boolean" } } },
          }),
        );
        fs.writeFileSync(
          path.join(setupDir, "index.cjs"),
          `module.exports = { id: ${JSON.stringify(setupId)}, register() {} };`,
        );
        fs.writeFileSync(
          path.join(setupDir, "setup-api.cjs"),
          `
${observe("setup-import")}
module.exports = { id: ${JSON.stringify(setupId)}, register(api) {
  api.registerAutoEnableProbe(({ config }) => {
    ${observe("setup-probe")}
    return config.acp?.enabled ? "fixture setup configured" : null;
  });
} };`,
        );
        seed.config.plugins.allow.push(nativeId, setupId);
        seed.config.plugins.load.paths.push(path.join(nativeDir, "index.cjs"), setupDir);
        Object.assign(seed.config.plugins.entries, {
          [nativeId]: { enabled: true },
          [setupId]: { enabled: true, config: { configured: true } },
        });
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
      expect(
        snapshots[0]?.pluginRegistry?.agentHarnesses.map(({ harness }) => harness.id),
      ).toContain(nativeId);
      const readObservations = (): Array<{ event: string; threadId: number }> =>
        fs
          .readFileSync(observations, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
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
      // Native inventory remains in the parent; provider refreshes must not execute
      // that harness or unrelated setup code in the shared worker.
      expect(
        catalogs.every((catalog) =>
          catalog.entries.some(
            (entry) => entry.id === "unselected-native-model" && entry.nativeRuntime === nativeId,
          ),
        ),
      ).toBe(true);
      expect.soft(readObservations().filter((entry) => entry.threadId !== threadId)).toEqual([]);
      expect(readObservations()).toContainEqual({ event: "native-catalog", threadId });
      const setup = resolvePluginRuntimeLoadContext({
        config: {
          ...fixture.config,
          acp: { enabled: true },
          plugins: { ...fixture.config.plugins, allow: [PROVIDER_ID] },
        },
        env: process.env,
        workspaceDir: fixture.workspaceDir,
        metadataSnapshot: snapshots[0]!.metadataSnapshot,
      });
      expect(setup.config.plugins?.allow).toContain(setupId);
      expect(setup.autoEnabledReasons[setupId]).toContain("fixture setup configured");
      expect(readObservations()).toContainEqual({ event: "setup-probe", threadId });
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
      expect(readObservations().filter((entry) => entry.threadId !== threadId)).toEqual([]);
      await closePreparedModelRuntimeSnapshots();
      expect(fs.existsSync(captureRoot)).toBe(false);
    } finally {
      workerChannel.unsubscribe(recordWorker);
    }
  });
});
