import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
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
import type {
  PreparedModelCatalogWorkerInput,
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.types.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();

function createCatalogPool(env: NodeJS.ProcessEnv) {
  return new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
    workerOptions: {
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: { sourceCaptureDirectory: makeTempDir("openclaw-catalog-heap-captures-") },
      env,
    },
  });
}

function catalogTask(value: PreparedModelCatalogWorkerInput): PreparedModelCatalogWorkerTask {
  return {
    value,
    request: {
      kind: "catalog",
      syntheticAuth: [],
      clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: value.input.env }),
    },
  };
}

it("bounds catalog worker retention across repeated fleet preparations", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  fs.writeFileSync(
    path.join(fixture.root, "plugin", "index.cjs"),
    `
const v8 = require("node:v8");
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
          v8.queryObjects(FinalizationRegistry);
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
};

async function createNativeCatalogFixture(options: {
  setup?: string;
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
    plugins: { ...fixture.config.plugins, load: { paths: [entry] } },
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

it("reuses one installed native ESM evaluation across 20 catalog context changes", async () => {
  await using fixture = await createNativeCatalogFixture({
    setup: `import { queryObjects } from "node:v8";
const control = new WeakRef({});
const retained = new Uint8Array(${NATIVE_ESM_BUFFER_BYTES});
retained[0] = 7;`,
    catalog: `if (retained[0] !== 7) throw new Error("lost retained module state");
// Measure retained buffers after collection, independent of the runtime's GC schedule.
queryObjects(WeakRef);
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
