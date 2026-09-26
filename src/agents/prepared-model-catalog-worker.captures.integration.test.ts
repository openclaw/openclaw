import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { threadId, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayAgentModelCatalogProjector } from "../gateway/server-methods/models-list-result.js";
import { sweepPluginSourceCaptureDirectories } from "../plugins/plugin-source-capture-directory.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./auth-profiles/store-runtime.js";
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
  it("keeps an enabled unselected native picker owner in the parent, not provider worker captures", async () => {
    const harnessId = "unselected-native-fixture";
    let observations = "";
    const fixture = await createFleetFixture(
      (seed) => {
        const pluginDir = path.join(seed.root, "native-only-plugin");
        fs.mkdirSync(pluginDir);
        observations = path.join(seed.root, "native-owner-observations.jsonl");
        fs.writeFileSync(observations, "");
        fs.writeFileSync(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: harnessId,
            activation: { onAgentHarnesses: [harnessId] },
            configSchema: { type: "object", additionalProperties: false },
          }),
        );
        const pluginFile = path.join(pluginDir, "index.cjs");
        fs.writeFileSync(
          pluginFile,
          `const fs = require("node:fs");
const { threadId } = require("node:worker_threads");
const observe = (event, params = {}) => fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ event, threadId, filename: __filename, agentId: params.agentId, agentDir: params.agentDir, workspaceDir: params.workspaceDir }) + "\\n");
module.exports = { id: ${JSON.stringify(harnessId)}, register(api) {
  observe("register");
  api.registerAgentHarness({
    id: ${JSON.stringify(harnessId)}, label: "Unselected native picker owner",
    authBootstrap: "harness", supports: () => ({ supported: true }),
    runAttempt: async () => ({ ok: false, error: "unused" }),
    loadModelCatalog: async (params) => {
      observe("native-catalog", params);
      return [{ provider: ${JSON.stringify(PROVIDER_ID)}, id: "unselected-native-model",
        name: "Unselected native model", nativeRuntime: ${JSON.stringify(harnessId)} }];
    },
  });
} };`,
        );
        seed.config.plugins.allow.push(harnessId);
        seed.config.plugins.load.paths.push(pluginFile);
        Object.assign(seed.config.plugins.entries, { [harnessId]: { enabled: true } });
      },
      true,
      { agentCount: 1 },
    );
    const snapshot = fixture.snapshots[0]!;
    // No configured model, primary, or picker runtime selects the enabled harness.
    expect(fixture.config.agents.defaults.models).toEqual({});
    expect(snapshot.pluginRegistry?.agentHarnesses.map(({ harness }) => harness.id)).toContain(
      harnessId,
    );
    const catalog = await loadCompletedFullCatalog(snapshot);
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
    );
    const native = catalog.entries.find(({ id }) => id === "unselected-native-model");
    expect(native).toMatchObject({ provider: PROVIDER_ID, nativeRuntime: harnessId });
    const auth = getPreparedModelFullCatalogAuth(catalog)!;
    expect(auth.authStore.profiles[`${PROVIDER_ID}:default`]).toMatchObject({
      key: `synthetic-catalog-${fixture.agentIds[0]}`,
    });
    const projector = createGatewayAgentModelCatalogProjector({
      cfg: fixture.config,
      agentId: snapshot.agentId!,
      snapshot: catalog,
      metadataSnapshot: snapshot.metadataSnapshot,
      preparedAuthStore: auth.authStore,
      preparedRuntimeAuthModes: auth.authModes,
      pluginRegistry: snapshot.pluginRegistry,
      isCurrent: snapshot.isCurrent,
      observationConfig: snapshot.observationConfig,
    });
    expect(projector.evaluateNative(native!, await projector.evaluateEntry(native!))).toMatchObject(
      {
        availability: true,
      },
    );
    const events = fs
      .readFileSync(observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; threadId: number; filename: string });
    console.info("Unselected native catalog ownership", JSON.stringify(events));
    expect(events.filter(({ event }) => event === "native-catalog")).toEqual([
      expect.objectContaining({
        threadId,
        agentId: snapshot.agentId,
        agentDir: snapshot.agentDir,
        workspaceDir: fixture.entries[fixture.agentIds[0]!]!.workspace,
      }),
    ]);
    expect(events.filter((event) => event.threadId !== threadId)).toEqual([]);
    const parentSource = events[0]!.filename;
    const captureRoot = parentSource.slice(
      0,
      parentSource.indexOf(`${path.sep}openclaw-plugin-build-`),
    );
    const workerRoots = fs
      .readdirSync(captureRoot)
      .filter((name) => name.startsWith("openclaw-model-catalog-"));
    expect(workerRoots).toHaveLength(1);
    const workerRoot = path.join(captureRoot, workerRoots[0]!);
    const workerCaptures = fs
      .readdirSync(workerRoot)
      .filter((name) => name.startsWith("openclaw-plugin-build-"));
    // The legacy external provider (no runtimeAugment declaration) keeps its one capture.
    expect(workerCaptures).toHaveLength(1);
    expect(
      fs.existsSync(
        path.join(
          workerRoot,
          workerCaptures[0]!,
          "package-0",
          "node_modules",
          "native-only-plugin",
        ),
      ),
    ).toBe(false);
    expect(snapshot.isCurrent()).toBe(true);
  });

  it("binds provider-worker load facts without probing an unrelated external setup entry", async () => {
    const setupId = "catalog-setup-only";
    const addedId = "catalog-request-provider";
    let observations = "";
    const fixture = await createFleetFixture(
      (seed) => {
        observations = path.join(seed.root, "activation-observations.jsonl");
        fs.writeFileSync(observations, "");
        const observe = (event: string) =>
          `require("node:fs").appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ event: ${JSON.stringify(event)}, threadId: require("node:worker_threads").threadId, filename: __filename }) + "\\n");`;
        const setupDir = path.join(seed.root, "setup-plugin");
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
            configSchema: {
              type: "object",
              properties: { configured: { type: "boolean" } },
              additionalProperties: false,
            },
          }),
        );
        fs.writeFileSync(
          path.join(setupDir, "index.cjs"),
          `${observe("parent-runtime")} module.exports = { id: ${JSON.stringify(setupId)}, register() {} };`,
        );
        fs.writeFileSync(
          path.join(setupDir, "setup-api.cjs"),
          `${observe("setup-import")} module.exports = { id: ${JSON.stringify(setupId)}, register(api) {
          api.registerAutoEnableProbe(({ config }) => { ${observe("setup-probe")} return config.acp?.enabled ? "fixture setup configured" : null; });
        } };`,
        );
        seed.config.plugins.load.paths.push(setupDir);
        Object.assign(seed.config.plugins.entries, {
          [setupId]: { enabled: true, config: { configured: true } },
          [addedId]: { enabled: true },
        });
        // An open authored policy becomes a provider-only allowlist in the worker plan.
        seed.config.plugins.allow.length = 0;
        const providerFile = path.join(seed.root, "plugin", "index.cjs");
        fs.writeFileSync(
          providerFile,
          observe("legacy-runtime") + fs.readFileSync(providerFile, "utf8"),
        );
        const bundled = path.join(seed.root, "bundled");
        const addedDir = path.join(bundled, addedId);
        fs.mkdirSync(addedDir, { recursive: true });
        fs.writeFileSync(
          path.join(addedDir, "package.json"),
          JSON.stringify({
            name: addedId,
            version: "1.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        fs.writeFileSync(
          path.join(addedDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: addedId,
            providers: [addedId],
            activation: { onStartup: false },
            enabledByDefault: true,
            modelCatalog: { discovery: { [addedId]: "runtime" } },
            configSchema: { type: "object", additionalProperties: false },
          }),
        );
        fs.writeFileSync(
          path.join(addedDir, "index.cjs"),
          `${observe("added-runtime")}
        module.exports = { id: ${JSON.stringify(addedId)}, register(api) {
          api.registerProvider({ id: ${JSON.stringify(addedId)}, label: "Requested provider", auth: [],
            catalog: { run() { ${observe("added-catalog")} return { provider: { api: "openai-completions", baseUrl: "https://request.example.test/v1",
              models: [{ id: "added-model", name: "Added model" }] } }; } },
          });
        } };`,
        );
        const agentDir = path.join(seed.env.OPENCLAW_STATE_DIR!, "agents", "fleet-a", "agent");
        const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
        saveAuthProfileStore(
          {
            ...store,
            profiles: {
              ...store.profiles,
              [addedId + ":default"]: {
                type: "api_key",
                provider: addedId,
                key: "synthetic-request-provider-key",
              },
            },
          },
          agentDir,
        );
        vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundled);
        vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
        vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
      },
      true,
      { agentCount: 1 },
    );
    const snapshot = fixture.snapshots[0]!;
    expect(snapshot.pluginRegistry?.plugins).toContainEqual(
      expect.objectContaining({ id: setupId, status: "loaded" }),
    );
    const catalog = await loadCompletedFullCatalog(snapshot);
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
    );
    const events = fs
      .readFileSync(observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; threadId: number; filename: string });
    console.info("Worker activation ownership", JSON.stringify(events));
    const workerEvents = events.filter((event) => event.threadId !== threadId);
    expect(workerEvents.filter(({ event }) => event.startsWith("setup-"))).toEqual([]);
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({ provider: addedId, id: "added-model" }),
    );
    expect(workerEvents.map(({ event }) => event)).toEqual([
      "legacy-runtime",
      "legacy-runtime",
      "added-runtime",
      "added-catalog",
    ]);
    // Real setup ownership still probes and repairs an enabled entry missing from an allowlist.
    const required = resolvePluginRuntimeLoadContext({
      config: {
        ...fixture.config,
        acp: { enabled: true },
        plugins: { ...fixture.config.plugins, allow: [PROVIDER_ID] },
      },
      env: process.env,
      workspaceDir: fixture.workspaceDir,
      metadataSnapshot: snapshot.metadataSnapshot,
    });
    expect(required.config.plugins?.allow).toContain(setupId);
    expect(required.autoEnabledReasons[setupId]).toContain("fixture setup configured");
    expect(snapshot.isCurrent()).toBe(true);
    const source = workerEvents[0]!.filename;
    const captureRoot = source.slice(0, source.indexOf(`${path.sep}openclaw-plugin-build-`));
    await closePreparedModelRuntimeSnapshots();
    expect(snapshot.isCurrent()).toBe(false);
    expect(fs.existsSync(captureRoot)).toBe(false);
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
      await sweepPluginSourceCaptureDirectories(fixture.env.OPENCLAW_STATE_DIR!);
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
