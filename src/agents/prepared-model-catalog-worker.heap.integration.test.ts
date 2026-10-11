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
  PLUGIN_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import type {
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();

it("bounds catalog worker retention across repeated fleet preparations", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  fs.writeFileSync(
    path.join(fixture.root, "plugin", "index.cjs"),
    `
const v8 = require("node:v8");
const state = globalThis[Symbol.for("openclaw.catalogHeapFixture")] ??= {
  callbacks: [], calls: 0, control: new WeakRef({})
};
const iterations = Number(process.env.OPENCLAW_CATALOG_HEAP_ITERATIONS ?? 12);
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  const run = function catalogRetentionHook() {
    state.calls++;
    if (state.calls % 100 === 0 || state.calls >= iterations) {
      // Collection follows earlier worker requests, so WeakRef targets are no longer job-kept.
      v8.queryObjects(WeakRef);
      require("node:fs").writeFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        callbacks: state.callbacks.filter(ref => ref.deref()).length,
        controlCollected: state.control.deref() === undefined
      }));
    }
    return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: "heap-model", name: "Heap model" }] } };
  };
  state.callbacks.push(new WeakRef(run));
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Heap fixture", auth: [], catalog: { run } });
} };`,
  );
  const manifestPath = path.join(fixture.root, "plugin", "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.configSchema = { type: "object", properties: { revision: { type: "number" } } };
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
      agentFacts: {
        input: {
          agentId: "main",
          agentDir: fixture.agentDir,
          inheritedAuthDir: fixture.agentDir,
          workspaceDir: fixture.workspaceDir,
          config,
          env: fixture.env,
        },
        env: fixture.env,
        authStore: { version: 1, profiles: {} },
        credentials: {},
        templateAuthStorage: AuthStorage.inMemory({}),
        providerIds: [PROVIDER_ID],
        configuredModelRefs: [],
        configuredRuntimeModels: [],
        runtimeCapabilityModels: [],
        configuredGeneratedCatalogPluginIds: [],
      },
      pluginMetadataSnapshot: metadata,
    });
  });
  const pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
    workerOptions: {
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: {
        sourceCaptureDirectory: makeTempDir("openclaw-catalog-heap-captures-"),
      },
      env: fixture.env,
    },
  });
  try {
    const hashes = new Map<number, string>();
    const count = Number(process.env.OPENCLAW_CATALOG_HEAP_ITERATIONS ?? 12);
    for (let index = 0; index < count; index++) {
      const revision = index % inputs.length;
      const result = await pool.run(
        {
          value: inputs[revision]!,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
        },
        { timeoutMs: 30_000 },
      );
      expect(result.status).toBe("ok");
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
    await pool.run(
      {
        value: inputs[(count - 1) % inputs.length]!,
        request: {
          kind: "catalog",
          syntheticAuth: [],
          clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
        },
      },
      { timeoutMs: 30_000 },
    );
    const retained = JSON.parse(fs.readFileSync(fixture.marker, "utf8")) as {
      callbacks: number;
      controlCollected: boolean;
    };
    expect(retained.controlCollected).toBe(true);
    expect(retained.callbacks).toBe(1);
  } finally {
    await pool.close();
  }
}, 300_000);

const NATIVE_ESM_BUFFER_BYTES = 4 * 1024 * 1024;

type NativeCatalogSample = {
  evaluations: number;
  registrations: number;
  revision: number;
  url: string;
  heapUsed: number;
  arrayBuffers: number;
  modelId: string;
  rejected?: boolean;
  neighborRejected?: boolean;
  effects?: number;
};

async function createNativeCatalogFixture(options: {
  setup?: string;
  catalog?: string;
  files?: Record<string, string>;
}) {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const pluginDir = path.join(fixture.root, "plugin");
  const entry = path.join(pluginDir, "index.js");
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ name: PLUGIN_ID, type: "module" }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      configSchema: {
        type: "object",
        properties: { revision: { type: "number" } },
      },
    }),
  );
  for (const [name, source] of Object.entries(options.files ?? {})) {
    fs.writeFileSync(path.join(pluginDir, name), source);
  }
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
      const { heapUsed, arrayBuffers } = process.memoryUsage();
      fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        evaluations: state.evaluations, registrations, revision, url: import.meta.url,
        heapUsed, arrayBuffers, modelId, ...extra,
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
      agentFacts: {
        input: {
          agentId: "main",
          agentDir: fixture.agentDir,
          inheritedAuthDir: fixture.agentDir,
          workspaceDir,
          config: {
            ...config,
            plugins: {
              ...config.plugins,
              entries: { [PLUGIN_ID]: { enabled: true, config: { revision } } },
            },
          },
          env: fixture.env,
        },
        env: fixture.env,
        authStore: { version: 1, profiles: {} },
        credentials: {},
        templateAuthStorage: AuthStorage.inMemory({}),
        providerIds: [PROVIDER_ID],
        configuredModelRefs: [],
        configuredRuntimeModels: [],
        runtimeCapabilityModels: [],
        configuredGeneratedCatalogPluginIds: [],
      },
      pluginMetadataSnapshot: metadataForWorkspace(workspaceDir),
    });
  const pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
    workerOptions: {
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: { sourceCaptureDirectory: makeTempDir("openclaw-native-retention-captures-") },
      env: fixture.env,
    },
  });
  const request = (revision: number, workspaceDir?: string, rejectDiscovery = false) =>
    pool.run(
      {
        value: input(revision, workspaceDir),
        request: {
          kind: "catalog",
          syntheticAuth: [],
          clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
        },
      },
      {
        timeoutMs: 30_000,
        ...(rejectDiscovery ? { onRequest: async () => ({ input: false }) } : {}),
      },
    );
  return {
    workspaceDir: fixture.workspaceDir,
    close: () => pool.close(),
    async rejectRefresh(revision: number) {
      const result = await request(revision, undefined, true);
      expect(result.status).toBe("failed");
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
  const fixture = await createNativeCatalogFixture({
    setup: `const retained = new Uint8Array(${NATIVE_ESM_BUFFER_BYTES});
retained[0] = 7;`,
    catalog: 'if (retained[0] !== 7) throw new Error("lost retained module state");',
  });
  const samples: NativeCatalogSample[] = [];
  try {
    for (let revision = 0; revision <= 20; revision++) {
      samples.push(await fixture.run(revision));
    }
  } finally {
    await fixture.close();
  }
  // Log before assertions so a main-branch failure still produces the complete baseline.
  if (process.env.OPENCLAW_NATIVE_RETENTION_MEASURE === "1") {
    console.log(JSON.stringify({ case: "native-esm-context-retention", samples }));
  }
  expect(samples.map((sample) => sample.revision)).toEqual(
    Array.from({ length: 21 }, (_, revision) => revision),
  );
  expect(samples.at(-1)?.registrations).toBe(21);
  expect(samples.map((sample) => sample.evaluations)).toEqual(Array(21).fill(1));
  expect(new Set(samples.map((sample) => sample.url)).size).toBe(1);
  expect(samples.at(-1)!.arrayBuffers - samples[0]!.arrayBuffers).toBeLessThan(
    NATIVE_ESM_BUFFER_BYTES,
  );
}, 180_000);

it("re-registers the requested config after a rejected native ESM refresh", async () => {
  const fixture = await createNativeCatalogFixture({
    catalog: 'modelId = "revision-" + latestApi.pluginConfig.revision;',
  });
  try {
    const first = await fixture.run(0);
    await fixture.rejectRefresh(1);
    const recovered = await fixture.run(0);
    expect(recovered.modelId).toBe("revision-0");
    expect(recovered.registrations).toBe(3);
    expect(recovered.evaluations).toBe(1);
    expect(recovered.url).toBe(first.url);
  } finally {
    await fixture.close();
  }
}, 60_000);

it("isolates retained native ESM state between workspaces sharing an installed entry", async () => {
  const fixture = await createNativeCatalogFixture({});
  const neighbor = makeTempDir("openclaw-native-retention-neighbor-");
  try {
    const first = await fixture.run(0);
    const second = await fixture.run(1, neighbor);
    const firstAgain = await fixture.run(2);
    const secondAgain = await fixture.run(3, neighbor);
    expect(first.url).not.toBe(second.url);
    expect(firstAgain.url).toBe(first.url);
    expect(secondAgain.url).toBe(second.url);
    expect([
      first.registrations,
      second.registrations,
      firstAgain.registrations,
      secondAgain.registrations,
    ]).toEqual([1, 1, 2, 2]);
    expect(secondAgain.evaluations).toBe(2);
  } finally {
    await fixture.close();
  }
}, 60_000);

it.each(["native", "compiled"] as const)(
  "resolves a retained %s helper after its original catalog generation is released",
  async (kind) => {
    const fixture = await createNativeCatalogFixture({
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
    try {
      const first = await fixture.run(0);
      await fixture.run(1);
      // A following task runs after the predecessor's asynchronous retirement.
      const afterRelease = await fixture.run(1);
      expect(afterRelease.modelId).toBe("imported-after-release");
      expect(afterRelease.url).toBe(first.url);
      expect(afterRelease.evaluations).toBe(1);
      expect(afterRelease.registrations).toBe(2);
    } finally {
      await fixture.close();
    }
  },
  60_000,
);

it("rejects neighboring and released generations using a retained replacement API", async () => {
  const fixture = await createNativeCatalogFixture({
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
  try {
    const first = await fixture.run(0);
    const replacement = await fixture.run(1);
    const foreign = await fixture.run(2, neighbor);
    const stillLive = await fixture.run(1);
    expect(replacement.url).toBe(first.url);
    expect(replacement.registrations).toBe(2);
    expect(foreign.url).not.toBe(first.url);
    expect(foreign.neighborRejected).toBe(true);
    expect(foreign.rejected).toBe(true);
    expect(foreign.effects).toBe(0);
    expect(stillLive.url).toBe(first.url);
    expect(stillLive.modelId).toBe("revision-1");
    if (process.env.OPENCLAW_NATIVE_RETENTION_MEASURE === "1") {
      console.log(
        JSON.stringify({
          case: "native-esm-registration-authority",
          first,
          replacement,
          foreign,
          stillLive,
        }),
      );
    }
  } finally {
    await fixture.close();
  }
}, 60_000);
