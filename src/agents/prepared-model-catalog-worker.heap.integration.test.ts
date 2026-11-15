import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MessagePort } from "node:worker_threads";
import { expect, it } from "vitest";
import {
  publishRemoteModelCatalogSnapshot,
  withRemoteModelCatalogSnapshot,
  type ActiveRemoteModelCatalog,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import {
  createCatalogFixture,
  catalogInput,
  makeCatalogAgentFacts,
  writeFixtureFiles,
  PLUGIN_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import type { PreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.types.js";
import {
  catalogTask,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const {
  makeTempDir,
  observeWorkers,
  createCatalogPool: createWorkerPool,
} = usePreparedCatalogWorkerFixtures();

function createCatalogPool(env: NodeJS.ProcessEnv) {
  const preload = path.join(makeTempDir("openclaw-catalog-retention-"), "preload.mjs");
  // A synchronous TypeScript require starts esbuild's persistent worker inside the catalog scope.
  fs.writeFileSync(
    preload,
    `import { forceFullGc } from ${JSON.stringify(new URL("../test-utils/retention.ts", import.meta.url).href)};
globalThis[Symbol.for("openclaw.test.catalog.forceFullGc")] = forceFullGc;`,
  );
  return createWorkerPool(env, pathToFileURL(preload));
}

it("shares remote catalog revisions across workspaces without retaining superseded copies", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  writeFixtureFiles(path.join(fixture.root, "plugin"), {
    "index.cjs": `module.exports = { id: ${JSON.stringify(PLUGIN_ID)}, register() {} };`,
    "openclaw.plugin.json": {
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      configSchema: { type: "object", additionalProperties: false },
      modelCatalog: {
        providers: {
          [PROVIDER_ID]: {
            api: "openai-completions",
            baseUrl: "https://catalog.invalid/v1",
            models: [{ id: "manifest-model", name: "Manifest model" }],
          },
        },
      },
    },
  });
  const catalog = (source: string, revision: string): ActiveRemoteModelCatalog => ({
    sourceUrl: `https://${source}.invalid/catalog.json`,
    revision,
    generatedAt: 1,
    providers: { [PROVIDER_ID]: { models: [{ id: `${source}-${revision}` }] } },
    recommendations: {},
    pricing: {},
    upstreamPricing: {},
  });
  const initial = catalog("first", "one");
  setRemoteModelCatalogOverlaySourcesForTest();
  expect(publishRemoteModelCatalogSnapshot(initial, null)).toBe(true);
  const memory = Promise.withResolvers<MessagePort>();
  const observer = observeWorkers((worker) => {
    worker.on("message", (message: { status?: string; port?: MessagePort }) => {
      if (message.status === "memory" && message.port instanceof MessagePort) {
        memory.resolve(message.port);
      }
    });
  });
  observer.subscribe();
  const pool = createCatalogPool(fixture.env);
  try {
    const run = async (
      workspace: string,
      remoteCatalog: ActiveRemoteModelCatalog | null,
      generations: number,
    ) => {
      const workspaceDir = path.join(fixture.root, workspace);
      fs.mkdirSync(workspaceDir, { recursive: true });
      const config = {
        plugins: fixture.config.plugins,
        models: { catalogRefresh: { url: remoteCatalog?.sourceUrl ?? initial.sourceUrl } },
      };
      const value = createPreparedModelCatalogWorkerInput({
        agentFacts: makeCatalogAgentFacts(catalogInput(fixture, { workspaceDir, config })),
        pluginMetadataSnapshot: loadPluginMetadataSnapshot({
          config,
          env: fixture.env,
          workspaceDir,
        }),
      });
      const result = await pool.run(catalogTask({ ...value, remoteCatalog }), {
        timeoutMs: 30_000,
      });
      if (result.status !== "ok" || result.kind !== "catalog") {
        throw new Error(JSON.stringify(result));
      }
      expect(result.snapshot.entries.map((row) => row.id)).toContain(
        remoteCatalog?.providers[PROVIDER_ID]?.models[0]?.id ?? "manifest-model",
      );
      const port = await memory.promise;
      const sample = once(port, "message");
      port.postMessage(undefined);
      const [retained] = await sample;
      expect(retained.retainedData).toContainEqual(
        expect.objectContaining({ structure: "catalog-remote", generations }),
      );
    };
    await run("one", initial, 1);
    await run("two", initial, 1);
    await run("one", catalog("first", "two"), 2);
    await run("two", catalog("first", "two"), 2);
    await run("one", catalog("second", "two"), 3);
    await run("two", catalog("second", "two"), 2);
    await run("one", null, 2);
    await run("two", null, 1);
  } finally {
    await pool.close();
    observer.close();
    setRemoteModelCatalogOverlaySourcesForTest();
  }
}, 120_000);

it("refreshes remote-derived catalogs without recapturing unchanged registrations", async () => {
  const bundledRoot = makeTempDir("openclaw-catalog-refresh-bundled-");
  const extra = "catalog-expansion-fixture";
  const borrowed = "catalog-borrowed-fixture";
  const synthetic = "catalog-synthetic-fixture";
  const fixture = await createCatalogFixture(makeTempDir, 0, {
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  });
  const scopeMarker = `${fixture.marker}.scope`;
  fs.mkdirSync(path.join(bundledRoot, extra));
  writeFixtureFiles(path.join(bundledRoot, extra), {
    "index.cjs": `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(extra)}, register(api) {
  const record = event => fs.appendFileSync(${JSON.stringify(scopeMarker)}, event + "\\n");
  record("registered");
  api.lifecycle.onDispose(() => record("disposed"));
  api.registerProvider({ id: ${JSON.stringify(extra)}, label: "Expansion fixture", auth: [],
    catalog: { run() { return { provider: {
      api: "openai-completions", baseUrl: "https://catalog.invalid/v1",
      models: [{ id: "expanded-model", name: "Expanded model" }]
    } }; } }
  });
} };`,
    "package.json": {
      name: extra,
      version: "0.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    },
    "openclaw.plugin.json": {
      id: extra,
      providers: [extra],
      modelCatalog: { discovery: { [extra]: "runtime" } },
      configSchema: { type: "object", additionalProperties: false },
    },
  });
  fs.mkdirSync(path.join(bundledRoot, borrowed));
  writeFixtureFiles(path.join(bundledRoot, borrowed), {
    "index.cjs": `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(borrowed)}, register(api) {
  api.registerProvider({ id: ${JSON.stringify(synthetic)}, label: "Synthetic fixture", auth: [],
    prepareSyntheticAuth() { throw new Error("Unexpected borrowed auth probe"); }
  });
  api.registerProvider({ id: ${JSON.stringify(borrowed)}, label: "Borrowed fixture", auth: [],
    catalog: { async run(context) {
      let key = null;
      try {
        key = (await api.runtime.modelAuth.resolveApiKeyForProvider({
          cfg: api.config, workspaceDir: context.workspaceDir, provider: ${JSON.stringify(synthetic)}
        })).apiKey;
      } catch (error) {
        if (error.code !== "missing-provider-auth") throw error;
      }
      fs.writeFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER + ".auth", JSON.stringify(key));
      return { provider: { api: "openai-completions", baseUrl: "https://catalog.invalid/v1",
        models: [{ id: "borrowed-model", contextWindow: 8192, maxTokens: 4096 }]
      } };
    } }
  });
} };`,
    "package.json": {
      name: borrowed,
      version: "0.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    },
    "openclaw.plugin.json": {
      id: borrowed,
      providers: [borrowed, synthetic],
      configSchema: { type: "object", additionalProperties: false },
      modelCatalog: { discovery: { [borrowed]: "runtime" } },
    },
  });
  writeFixtureFiles(path.join(fixture.root, "plugin"), {
    "index.cjs": `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(PLUGIN_ID)}, register(api) {
  fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, __filename + "\\n");
  api.lifecycle.onDispose(() => fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER + ".disposed", __filename + "\\n"));
} };`,
    "openclaw.plugin.json": {
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      configSchema: { type: "object", properties: { revision: { type: "number" } } },
      modelCatalog: {
        providers: {
          [PROVIDER_ID]: {
            api: "openai-completions",
            baseUrl: "https://catalog.invalid/v1",
            models: [{ id: "manifest-model", contextWindow: 8192, maxTokens: 4096 }],
          },
        },
      },
    },
  });
  // Both URLs serve the default config across the documented v1 -> v2 catalog upgrade.
  const catalog = (revision: string, version: number, price: number): ActiveRemoteModelCatalog => ({
    sourceUrl: `https://catalog.openclaw.ai/models/v${version}/catalog.json`,
    revision,
    generatedAt: price,
    providers: {
      [PROVIDER_ID]: {
        models: [
          {
            id: `remote-${price}`,
            contextWindow: 8192,
            maxTokens: 4096,
            cost: { input: price, output: price, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
    recommendations: {},
    pricing: {},
    upstreamPricing: {},
  });
  const config = {
    plugins: {
      ...fixture.config.plugins,
      allow: [...fixture.config.plugins.allow, borrowed, extra],
      entries: {
        ...fixture.config.plugins.entries,
        [borrowed]: { enabled: true },
        [extra]: { enabled: true },
      },
    },
    models: {
      providers: {
        [PROVIDER_ID]: {
          api: "openai-completions" as const,
          apiKey: "synthetic-catalog-key",
          baseUrl: "https://catalog.invalid/v1",
          models: [],
        },
      },
    },
  };
  const metadata = loadPluginMetadataSnapshot({
    config,
    env: fixture.env,
    workspaceDir: fixture.workspaceDir,
  });
  const input = (remoteCatalog: ActiveRemoteModelCatalog | null, revision?: number) => ({
    ...createPreparedModelCatalogWorkerInput({
      agentFacts: makeCatalogAgentFacts(
        catalogInput(fixture, {
          config: {
            ...config,
            plugins: {
              ...config.plugins,
              entries: {
                ...config.plugins.entries,
                [PLUGIN_ID]: { enabled: true, config: { revision } },
              },
            },
          },
        }),
      ),
      pluginMetadataSnapshot: metadata,
    }),
    remoteCatalog,
  });
  const registrations = () => fs.readFileSync(fixture.marker, "utf8").trim().split("\n");
  const pool = createCatalogPool(fixture.env);
  const authKey = (value: PreparedModelCatalogWorkerInput) =>
    value.remoteCatalog ? `synthetic-${value.remoteCatalog.generatedAt}` : null;
  const taskFor = (value: PreparedModelCatalogWorkerInput) => {
    const task = catalogTask(value);
    const key = authKey(value);
    task.request = {
      ...task.request,
      providerIds: [PROVIDER_ID, borrowed],
      syntheticAuth: [
        {
          providerRef: synthetic,
          result: key ? { apiKey: key, source: "fixture", mode: "api-key" } : null,
        },
      ],
    };
    return task;
  };
  const run = async (value: PreparedModelCatalogWorkerInput, omitMetadata = false) => {
    const task = taskFor(value);
    if (omitMetadata) {
      const { remoteCatalog: _remote, pluginMetadataSnapshot: _metadata, ...request } = value;
      task.value = request;
    }
    const result = await pool.run(task, { timeoutMs: 30_000 });
    if (result.status !== "ok" || result.kind !== "catalog") {
      throw new Error(JSON.stringify(result));
    }
    const models = result.runtimeModels.get(PROVIDER_ID);
    expect(models).toBeDefined();
    expect(result.runtimeModels.get(borrowed)).toContainEqual(
      expect.objectContaining({ id: "borrowed-model" }),
    );
    expect(JSON.parse(fs.readFileSync(`${fixture.marker}.auth`, "utf8"))).toBe(authKey(value));
    if (!value.remoteCatalog) {
      expect(models).toContainEqual(expect.objectContaining({ id: "manifest-model" }));
    }
    return models!.filter((model) => model.id.startsWith("remote-"));
  };
  try {
    const first = input(catalog("A", 1, 1));
    await run(first);
    const expanded = taskFor(input(catalog("B", 1, 2)));
    expanded.request = { ...expanded.request, providerIds: [PROVIDER_ID, borrowed, extra] };
    // Reject only after the worker acquires the expanded registry, before it can publish B.
    const failed = await pool.run(expanded, {
      timeoutMs: 30_000,
      onRequest: async () => ({ input: false, timeoutMs: 30_000 }),
    });
    expect(failed).toMatchObject({
      status: "failed",
      error: "prepared model catalog request retired before discovery",
    });
    expect(fs.readFileSync(scopeMarker, "utf8")).toBe("registered\ndisposed\n");
    expect(fs.existsSync(`${fixture.marker}.disposed`)).toBe(false);
    expect((await run(first, true)).map((model) => model.id)).toEqual(["remote-1"]);
    expect(registrations()).toHaveLength(1);
    const retried = await pool.run(expanded, { timeoutMs: 30_000 });
    expect(retried).toMatchObject({ status: "ok", kind: "catalog" });
    if (retried.status === "ok" && retried.kind === "catalog") {
      expect(retried.runtimeModels.get(borrowed)).toContainEqual(
        expect.objectContaining({ id: "borrowed-model" }),
      );
      expect(retried.runtimeModels.get(extra)).toContainEqual(
        expect.objectContaining({ id: "expanded-model" }),
      );
    }
    expect(JSON.parse(fs.readFileSync(`${fixture.marker}.auth`, "utf8"))).toBe("synthetic-2");
    expect(fs.readFileSync(scopeMarker, "utf8")).toBe("registered\ndisposed\nregistered\n");
    expect(fs.existsSync(`${fixture.marker}.disposed`)).toBe(false);
    for (const remote of [catalog("A", 1, 1), catalog("B", 1, 2), catalog("B", 2, 3), null]) {
      for (const omitMetadata of [false, true]) {
        const rows = await run(input(remote), omitMetadata);
        expect(rows.map((model) => model.id)).toEqual(
          remote ? [`remote-${remote.generatedAt}`] : [],
        );
        if (remote) {
          expect(rows[0]!.cost.input).toBe(remote.generatedAt);
        }
      }
    }
    expect(registrations()).toHaveLength(1);
    expect(new Set(registrations()).size).toBe(1);
    expect(fs.existsSync(`${fixture.marker}.disposed`)).toBe(false);
    await run(input(catalog("C", 2, 4), 1));
    expect(registrations()).toHaveLength(2);
    expect(new Set(registrations()).size).toBe(2);
    expect(fs.readFileSync(`${fixture.marker}.disposed`, "utf8").trim()).toBe(registrations()[0]);
    expect(fs.readFileSync(scopeMarker, "utf8")).toBe(
      "registered\ndisposed\nregistered\ndisposed\n",
    );
  } finally {
    await pool.close();
  }
}, 120_000);

it("collects superseded remote snapshots while reusing registered catalog callbacks", async () => {
  setRemoteModelCatalogOverlaySourcesForTest();
  const fixture = await createCatalogFixture(makeTempDir, 0);
  writeFixtureFiles(path.join(fixture.root, "plugin"), {
    "index.cjs": `
const fs = require("node:fs");
const forceFullGc = globalThis[Symbol.for("openclaw.test.catalog.forceFullGc")];
const state = globalThis[Symbol.for("catalog.remote.retention")] ??= {
  snapshots: new Map(), configs: new Map(), callbacks: [], captures: [], control: new WeakRef({})
};
module.exports = { id: ${JSON.stringify(PLUGIN_ID)}, register(api) {
  state.captures.push(new WeakRef(api.config));
  const run = async () => {
    // Observe the actual worker scope without adding a production inspection seam.
    const catalog = globalThis[Symbol.for("openclaw.asyncContext")].getStore()
      [Symbol.for("openclaw.remoteModelCatalogScope")].catalog;
    state.snapshots.set(catalog.revision, new WeakRef(catalog));
    const config = api.runtime.config.current();
    state.configs.set(config.plugins.entries[${JSON.stringify(PLUGIN_ID)}].config.revision, new WeakRef(config));
    for (let pass = 0; pass < 2; pass++) {
      await new Promise(resolve => setImmediate(() => {
        forceFullGc();
        resolve();
      }));
    }
    fs.writeFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
      snapshots: [...state.snapshots].filter(([, ref]) => ref.deref()).map(([revision]) => revision),
      configs: [...state.configs].filter(([, ref]) => ref.deref()).map(([revision]) => revision),
      callbacks: state.callbacks.filter(ref => ref.deref()).length,
      captures: state.captures.filter(ref => ref.deref()).length,
      controlCollected: state.control.deref() === undefined
    }));
    return { provider: { api: "openai-completions", baseUrl: "https://catalog.invalid/v1",
      models: [{ id: catalog.revision, name: catalog.revision }]
    } };
  };
  state.callbacks.push(new WeakRef(run));
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Retention fixture", auth: [],
    catalog: { run }
  });
} };`,
    "openclaw.plugin.json": {
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      configSchema: { type: "object", properties: { revision: { type: "number" } } },
      modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" } },
    },
  });
  const metadata = loadPluginMetadataSnapshot({
    config: fixture.config,
    env: fixture.env,
    workspaceDir: fixture.workspaceDir,
  });
  const pool = createCatalogPool(fixture.env);
  try {
    for (const [index, revision] of ["A", "B", "C", "D"].entries()) {
      const value = {
        ...createPreparedModelCatalogWorkerInput({
          agentFacts: makeCatalogAgentFacts(
            catalogInput(fixture, {
              config: {
                ...fixture.config,
                plugins: {
                  ...fixture.config.plugins,
                  entries: {
                    [PLUGIN_ID]: { enabled: true, config: { revision: index === 3 ? 1 : 0 } },
                  },
                },
              },
            }),
          ),
          pluginMetadataSnapshot: metadata,
        }),
        remoteCatalog: {
          sourceUrl: "https://catalog.openclaw.ai/models/v2/catalog.json",
          revision,
          generatedAt: index,
          providers: {},
          recommendations: {},
          pricing: {},
          upstreamPricing: {},
        },
      };
      // The second request observes the settled predecessor after all worker owners advance.
      for (let request = 0; request < 2; request++) {
        const result = await pool.run(catalogTask(value), { timeoutMs: 30_000 });
        expect(result).toMatchObject({ status: "ok", kind: "catalog" });
        if (result.status === "ok" && result.kind === "catalog") {
          expect(result.runtimeModels.get(PROVIDER_ID)).toContainEqual(
            expect.objectContaining({ id: revision }),
          );
        }
      }
      expect(JSON.parse(fs.readFileSync(fixture.marker, "utf8"))).toEqual({
        snapshots: [revision],
        configs: [index === 3 ? 1 : 0],
        callbacks: 1,
        captures: 1,
        controlCollected: true,
      });
    }
  } finally {
    await pool.close();
    setRemoteModelCatalogOverlaySourcesForTest();
  }
}, 120_000);

it("bounds catalog worker retention across repeated fleet preparations", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  fs.writeFileSync(
    path.join(fixture.root, "plugin", "index.cjs"),
    `
const forceFullGc = globalThis[Symbol.for("openclaw.test.catalog.forceFullGc")];
const state = globalThis[Symbol.for("openclaw.catalogHeapFixture")] ??= {
  callbacks: 0, finalizedCallbacks: 0, calls: 0, controlCollected: false
};
if (!state.registry) {
  state.registry = new FinalizationRegistry(kind => {
    if (kind === "callback") state.finalizedCallbacks++;
    else state.controlCollected = true;
  });
  state.registry.register({}, "control");
}
const iterations = Number(process.env.OPENCLAW_CATALOG_HEAP_ITERATIONS ?? 12);
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  const run = async function catalogRetentionHook() {
    state.calls++;
    if (state.calls % 100 === 0 || state.calls >= iterations) {
      // JSC's promise stack can retain completed callbacks; collect from native immediates.
      for (let pass = 0; pass < 8; pass++) {
        await new Promise(resolve => setImmediate(() => {
          forceFullGc();
          resolve();
        }));
      }
      require("node:fs").writeFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        callbacks: state.callbacks - state.finalizedCallbacks,
        controlCollected: state.controlCollected
      }));
    }
    return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: "heap-model", name: "Heap model" }] } };
  };
  state.callbacks++;
  state.registry.register(run, "callback");
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Heap fixture", auth: [], catalog: { run } });
} };`,
  );
  const manifestPath = path.join(fixture.root, "plugin", "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.configSchema = revisionSchema;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const metadata = loadPluginMetadataSnapshot({
    config: fixture.config,
    env: fixture.env,
    workspaceDir: fixture.workspaceDir,
  });
  const inputs = Array.from({ length: 4 }, (_, revision) => {
    const config = {
      ...fixture.config,
      plugins: {
        ...fixture.config.plugins,
        entries: { [PROVIDER_ID]: { enabled: true, config: { revision } } },
      },
      models: {
        providers: {
          [PROVIDER_ID]: {
            baseUrl: `https://revision-${revision}.invalid/v1`,
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };
    return createPreparedModelCatalogWorkerInput({
      agentFacts: makeCatalogAgentFacts(catalogInput(fixture, { config })),
      pluginMetadataSnapshot: metadata,
    });
  });
  const pool = createCatalogPool(fixture.env);
  try {
    const hashes = new Map<number, string>();
    const count = Number(process.env.OPENCLAW_CATALOG_HEAP_ITERATIONS ?? 12);
    for (let index = 0; index < count; index++) {
      const revision = index % inputs.length;
      const result = await pool.run(catalogTask(inputs[revision]!), { timeoutMs: 30_000 });
      if (result.status !== "ok" || result.kind !== "catalog") {
        throw new Error(JSON.stringify(result));
      }
      const hash = createHash("sha256")
        .update(JSON.stringify(result.snapshot.entries))
        .digest("hex");
      if (hashes.has(revision)) {
        expect(hash).toBe(hashes.get(revision));
      }
      hashes.set(revision, hash);
    }
    // Reuse the last generation after its predecessor's retirement has completed.
    await pool.run(catalogTask(inputs[(count - 1) % inputs.length]!), { timeoutMs: 30_000 });
    const retained = JSON.parse(fs.readFileSync(fixture.marker, "utf8")) as {
      callbacks: number;
      controlCollected: boolean;
    };
    expect(retained).toMatchObject({ controlCollected: true, callbacks: 1 });
  } finally {
    await pool.close();
  }
}, 300_000);

const NATIVE_ESM_BUFFER_BYTES = 4 * 1024 * 1024;
const revisionSchema = { type: "object", properties: { revision: { type: "number" } } };

type NativeCatalogSample = {
  evaluations: number;
  registrations: number;
  revision: number;
  url: string;
  arrayBuffers: number;
  modelId: string;
  rejected?: boolean;
  neighborRejected?: boolean;
  effects?: number;
  controlCollected?: boolean;
  descriptorReads?: number;
  snapshotFrozen?: boolean;
  snapshotBytes?: string;
  configCaptures?: number;
};

async function createNativeCatalogFixture(options: {
  setup?: string;
  register?: string;
  catalog?: string;
  files?: Record<string, string>;
}) {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const pluginDir = path.join(fixture.root, "plugin");
  const entry = path.join(pluginDir, "index.js");
  writeFixtureFiles(pluginDir, {
    "package.json": { name: PLUGIN_ID, type: "module" },
    "openclaw.plugin.json": {
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      configSchema: revisionSchema,
    },
    ...options.files,
  });
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
const state = globalThis[Symbol.for("openclaw.nativeRetentionFixture")] ??= { evaluations: 0 };
state.evaluations++;
let registrations = 0;
let catalogs = 0;
let latestApi;
${options.setup ?? ""}
export function register(api) {
  registrations++;
  latestApi = api;
  const revision = api.pluginConfig.revision;
  ${options.register ?? ""}
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER_ID)}, label: "Native retention", auth: [],
    catalog: { async run() {
      catalogs++;
      let modelId = "revision-" + revision;
      let extra = {};
      ${options.catalog ?? ""}
      const { arrayBuffers } = process.memoryUsage();
      fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        evaluations: state.evaluations, registrations, revision, url: import.meta.url,
        arrayBuffers, modelId, ...extra,
      }) + "\\n");
      return { provider: { api: "openai-completions", baseUrl: "https://retention.invalid/v1",
        models: [{ id: modelId, name: modelId }] } };
    } },
  });
}`,
  );
  const config = {
    ...fixture.config,
    plugins: {
      ...fixture.config.plugins,
      load: { paths: [entry] },
      // Keep registration inputs stable instead of applying Vitest's memory defaults per load.
      slots: { memory: "none" },
    },
  };
  const metadataByWorkspace = new Map<string, PluginMetadataSnapshot>();
  const metadataForWorkspace = (workspaceDir: string) => {
    let metadata = metadataByWorkspace.get(workspaceDir);
    if (!metadata) {
      metadata = loadPluginMetadataSnapshot({ config, env: fixture.env, workspaceDir });
      metadataByWorkspace.set(workspaceDir, metadata);
    }
    return metadata;
  };
  const input = (revision: number, workspaceDir = fixture.workspaceDir) =>
    createPreparedModelCatalogWorkerInput({
      agentFacts: makeCatalogAgentFacts(
        catalogInput(fixture, {
          workspaceDir,
          config: {
            ...config,
            plugins: {
              ...config.plugins,
              entries: { [PLUGIN_ID]: { enabled: true, config: { revision } } },
            },
          },
        }),
      ),
      pluginMetadataSnapshot: metadataForWorkspace(workspaceDir),
    });
  const pool = createCatalogPool(fixture.env);
  const request = (revision: number, workspaceDir?: string, rejectDiscovery = false) =>
    pool.run(catalogTask(input(revision, workspaceDir)), {
      timeoutMs: 30_000,
      ...(rejectDiscovery ? { onRequest: async () => ({ input: false, timeoutMs: 30_000 }) } : {}),
    });
  return {
    [Symbol.asyncDispose]: () => pool.close(),
    async rejectRefresh(revision: number) {
      const result = await request(revision, undefined, true);
      if (result.status !== "failed") {
        throw new Error(JSON.stringify(result));
      }
      expect(result.error).toBe("prepared model catalog request retired before discovery");
    },
    async run(revision: number, workspaceDir?: string) {
      const result = await request(revision, workspaceDir);
      if (result.status !== "ok" || result.kind !== "catalog") {
        throw new Error(JSON.stringify(result));
      }
      const sample = JSON.parse(
        fs.readFileSync(fixture.marker, "utf8").trim().split("\n").at(-1)!,
      ) as NativeCatalogSample;
      expect(result.snapshot.entries.map((row) => row.id)).toContain(sample.modelId);
      return sample;
    },
  };
}

it("freezes cloned remote catalog data without inspecting each model property again", async () => {
  const remoteCatalog: ActiveRemoteModelCatalog = {
    sourceUrl: "https://freeze-probe.invalid/catalog.json",
    revision: "synthetic-revision",
    generatedAt: 1,
    providers: {
      probe: {
        models: Array.from({ length: 100 }, (_, index) => ({
          id: `remote-probe-${index}`,
          input: ["text"],
          cost: { input: 1, output: 2 },
        })),
      },
    },
    recommendations: { probe: ["remote-probe-0"] },
    pricing: {},
    upstreamPricing: {},
  };
  await using fixture = await createNativeCatalogFixture({
    // Instrument only the private worker, after its first task installs this plugin.
    setup: `const descriptor = Object.getOwnPropertyDescriptor;
const freeze = Object.freeze;
let descriptorReads = 0;
let snapshot;
let rows = new Set();
Object.getOwnPropertyDescriptor = function(value, key) {
  if (rows.has(value) && !Object.isFrozen(value)) descriptorReads++;
  return descriptor(value, key);
};
Object.freeze = function(value) {
  if (value?.sourceUrl === "https://freeze-probe.invalid/catalog.json") {
    snapshot = value;
    rows = new Set(value.providers.probe.models);
    descriptorReads = 0;
  }
  return freeze(value);
};`,
    catalog: `if (snapshot) {
  Object.getOwnPropertyDescriptor = descriptor;
  Object.freeze = freeze;
  const pending = [snapshot];
  let snapshotFrozen = true;
  while (pending.length) {
    const value = pending.pop();
    snapshotFrozen &&= Object.isFrozen(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") pending.push(child);
    }
  }
  extra = { descriptorReads, snapshotFrozen, snapshotBytes: JSON.stringify(snapshot) };
}`,
  });
  await fixture.run(0);
  const observed = await withRemoteModelCatalogSnapshot(remoteCatalog, () => fixture.run(1));
  expect(observed.snapshotBytes).toBe(JSON.stringify(remoteCatalog));
  expect(observed.snapshotFrozen).toBe(true);
  expect(observed.descriptorReads).toBe(0);
}, 60_000);

it("reuses immutable config across remote catalog revisions but captures config changes", async () => {
  await using fixture = await createNativeCatalogFixture({
    setup: "const configs = new WeakSet(); let configCaptures = 0;",
    register: `if (!configs.has(api.config)) {
  configs.add(api.config);
  configCaptures++;
}`,
    catalog: "extra = { configCaptures };",
  });
  const run = (revision: string, configRevision: number) =>
    withRemoteModelCatalogSnapshot(
      {
        sourceUrl: "https://capture-reuse.invalid/catalog.json",
        revision,
        generatedAt: 1,
        providers: {},
        recommendations: {},
        pricing: {},
        upstreamPricing: {},
      },
      () => fixture.run(configRevision),
    );
  expect(await run("one", 0)).toMatchObject({ registrations: 1, configCaptures: 1 });
  expect(await run("two", 0)).toMatchObject({ registrations: 1, configCaptures: 1 });
  expect(await run("three", 1)).toMatchObject({
    registrations: 2,
    configCaptures: 2,
    modelId: "revision-1",
  });
  expect(await run("four", 1)).toMatchObject({ registrations: 2, configCaptures: 2 });
}, 60_000);

it("reuses one installed native ESM evaluation across 20 catalog context changes", async () => {
  await using fixture = await createNativeCatalogFixture({
    setup: `const forceFullGc = globalThis[Symbol.for("openclaw.test.catalog.forceFullGc")];
const control = new WeakRef({});
const retained = new Uint8Array(${NATIVE_ESM_BUFFER_BYTES});
retained[0] = 7;`,
    catalog: `if (retained[0] !== 7) throw new Error("lost retained module state");
// Measure retained buffers after collection, independent of the runtime's GC schedule.
forceFullGc();
extra = { controlCollected: control.deref() === undefined };`,
  });
  const samples: NativeCatalogSample[] = [];
  for (let revision = 0; revision <= 20; revision++) {
    samples.push(await fixture.run(revision));
  }
  expect(samples.map((sample) => sample.revision)).toEqual(
    Array.from({ length: 21 }, (_, revision) => revision),
  );
  expect(samples.at(-1)?.registrations).toBe(21);
  expect(samples.map((sample) => sample.evaluations)).toEqual(Array(21).fill(1));
  expect(new Set(samples.map((sample) => sample.url)).size).toBe(1);
  expect(samples.at(-1)?.controlCollected).toBe(true);
  expect(samples.at(-1)!.arrayBuffers - samples[0]!.arrayBuffers).toBeLessThan(
    NATIVE_ESM_BUFFER_BYTES,
  );
}, 180_000);

it("re-registers the requested config after a rejected native ESM refresh", async () => {
  await using fixture = await createNativeCatalogFixture({
    catalog: 'modelId = "revision-" + latestApi.pluginConfig.revision;',
  });
  const first = await fixture.run(0);
  await fixture.rejectRefresh(1);
  expect(await fixture.run(0)).toMatchObject({
    modelId: "revision-0",
    registrations: 3,
    evaluations: 1,
    url: first.url,
  });
}, 60_000);

it.each(["native", "compiled"] as const)(
  "resolves a retained %s helper after its original catalog generation is released",
  async (kind) => {
    await using fixture = await createNativeCatalogFixture({
      setup: kind === "compiled" ? 'import { readLater } from "./helper.ts";' : "",
      // The import must first execute after the generation that compiled it has retired.
      catalog: `if (catalogs >= 3) {
        modelId = ${kind === "compiled" ? "await readLater()" : '(await import("./later.js")).modelId'};
      }`,
      files: {
        "helper.ts":
          'export async function readLater(): Promise<string> { return (await import("./later.js")).modelId; }',
        "later.js": 'export const modelId = "imported-after-release";',
      },
    });
    const first = await fixture.run(0);
    await fixture.run(1);
    // A following task runs after the predecessor's asynchronous retirement.
    expect(await fixture.run(1)).toMatchObject({
      modelId: "imported-after-release",
      url: first.url,
      evaluations: 1,
      registrations: 2,
    });
  },
  60_000,
);

it("rejects neighboring and released generations using a retained replacement API", async () => {
  await using fixture = await createNativeCatalogFixture({
    setup: `const slot = globalThis[Symbol.for("openclaw.nativeRetentionAuthority")] ??= {
  gate: Promise.withResolvers(), effects: 0
};
slot.call ??= () => {
  latestApi.registerProvider({ id: "foreign-provider", label: "Foreign", auth: [] });
  slot.effects++;
};`,
    catalog: `if (revision === 0) {
        slot.stale = slot.gate.promise.then(slot.call);
      } else if (revision === 2) {
        let neighborRejected = false;
        try { slot.call(); } catch (error) {
          if (!error.message.includes("calling workspace generation")) throw error;
          neighborRejected = true;
        }
        slot.gate.resolve();
        let rejected = false;
        try { await slot.stale; } catch (error) {
          if (!error.message.includes("calling workspace generation")) throw error;
          rejected = true;
        }
        extra = { rejected, neighborRejected, effects: slot.effects };
      }`,
  });
  const neighbor = makeTempDir("openclaw-native-authority-neighbor-");
  const first = await fixture.run(0);
  const replacement = await fixture.run(1);
  const foreign = await fixture.run(2, neighbor);
  const stillLive = await fixture.run(1);
  const firstAgain = await fixture.run(3);
  const neighborAgain = await fixture.run(4, neighbor);
  expect(replacement).toMatchObject({ url: first.url, registrations: 2 });
  expect(foreign.url).not.toBe(first.url);
  expect(foreign).toMatchObject({ neighborRejected: true, rejected: true, effects: 0 });
  expect(stillLive).toMatchObject({ url: first.url, modelId: "revision-1" });
  expect(first.registrations).toBe(1);
  expect(foreign.registrations).toBe(1);
  expect(firstAgain).toMatchObject({ url: first.url, registrations: 3 });
  expect(neighborAgain).toMatchObject({ url: foreign.url, registrations: 2, evaluations: 2 });
}, 60_000);
