import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
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
  const fixture = await Promise.resolve(createCatalogFixture(makeTempDir, 0));
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

it("bounds catalog worker memory across repeated native ESM plugin generations", async () => {
  const fixture = await Promise.resolve(createCatalogFixture(makeTempDir, 0));
  const cjsEntry = fixture.config.plugins.load.paths[0];
  if (!cjsEntry) {
    throw new Error("catalog fixture did not register a plugin entry");
  }
  const pluginDir = path.dirname(cjsEntry);
  fs.rmSync(cjsEntry, { force: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ name: PLUGIN_ID, type: "module" }),
  );
  const entry = path.join(pluginDir, "index.js");
  fs.writeFileSync(
    path.join(pluginDir, "lazy.js"),
    `const state = globalThis[Symbol.for("openclaw.nativeEsmCatalogLazy")] ??= { evaluations: 0 };
state.evaluations += 1;
export const modelId = "lazy-heap-model";
export const evaluations = state.evaluations;
`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "later.js"),
    `const state = globalThis[Symbol.for("openclaw.nativeEsmCatalogLater")] ??= { evaluations: 0 };
state.evaluations += 1;
const lazy = await import("./lazy.js");
export const modelId = lazy.modelId;
export const evaluations = state.evaluations;
export const lazyEvaluations = lazy.evaluations;
`,
  );
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
const retained = new Uint8Array(${NATIVE_ESM_BUFFER_BYTES});
retained[0] = 7;
const state = globalThis[Symbol.for("openclaw.nativeEsmCatalogHeap")] ??= { evaluations: 0 };
state.evaluations += 1;
function record(extra) {
  fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
    evaluations: state.evaluations,
    url: import.meta.url,
    arrayBuffers: process.memoryUsage().arrayBuffers,
    ...extra,
  }) + "\\n");
}
record({ phase: "evaluate" });
export function register(api) {
  if (retained[0] !== 7) throw new Error("retained native ESM buffer was collected");
  const revision = Number(api?.pluginConfig?.revision ?? 0);
  record({ phase: "register", revision });
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER_ID)},
    label: "Heap fixture",
    auth: [],
    catalog: { async run() {
      let modelId = "heap-model";
      let laterEvaluations;
      let lazyEvaluations;
      if (revision >= 2) {
        const later = await import("./later.js");
        modelId = later.modelId;
        laterEvaluations = later.evaluations;
        lazyEvaluations = later.lazyEvaluations;
      }
      record({ phase: "catalog", revision, modelId, laterEvaluations, lazyEvaluations });
      return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: modelId, name: "Heap model" }] } };
    } },
  });
}
`,
  );
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    configSchema?: { type?: string; properties?: Record<string, unknown> };
  };
  manifest.configSchema = {
    type: "object",
    ...manifest.configSchema,
    properties: { ...manifest.configSchema?.properties, revision: { type: "number" } },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const baseConfig = {
    ...fixture.config,
    plugins: {
      ...fixture.config.plugins,
      load: { paths: [entry] },
    },
  };
  const metadata = loadPluginMetadataSnapshot({
    config: baseConfig,
    env: fixture.env,
    workspaceDir: fixture.workspaceDir,
  });
  const revisions = Array.from({ length: 6 }, (_, revision) =>
    createPreparedModelCatalogWorkerInput({
      agentFacts: {
        input: {
          agentId: "main",
          agentDir: fixture.agentDir,
          inheritedAuthDir: fixture.agentDir,
          workspaceDir: fixture.workspaceDir,
          config: {
            ...baseConfig,
            plugins: {
              ...baseConfig.plugins,
              entries: { [PLUGIN_ID]: { enabled: true, config: { revision } } },
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
      pluginMetadataSnapshot: metadata,
    }),
  );
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
  const samples: Array<{
    evaluations: number;
    arrayBuffers: number;
    url: string;
    revision?: number;
    modelId?: string;
    laterEvaluations?: number;
    lazyEvaluations?: number;
    catalogModelIds: string[];
  }> = [];
  try {
    for (const revision of revisions) {
      const result = await pool.run(
        {
          value: revision,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
        },
        { timeoutMs: 60_000 },
      );
      if (result.status !== "ok") {
        console.log(JSON.stringify(result));
      }
      expect(result.status).toBe("ok");
      const catalogModelIds =
        result.status === "ok" && result.kind === "catalog"
          ? result.snapshot.entries.map((catalogEntry) => catalogEntry.id)
          : [];
      const rows = fs
        .readFileSync(fixture.marker, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              evaluations: number;
              url: string;
              arrayBuffers: number;
              phase?: string;
              revision?: number;
              modelId?: string;
              laterEvaluations?: number;
              lazyEvaluations?: number;
            },
        );
      const latest = rows.at(-1)!;
      samples.push({
        evaluations: latest.evaluations,
        arrayBuffers: latest.arrayBuffers,
        url: latest.url,
        revision: latest.revision,
        modelId: latest.modelId,
        laterEvaluations: latest.laterEvaluations,
        lazyEvaluations: latest.lazyEvaluations,
        catalogModelIds,
      });
    }
  } finally {
    await pool.close();
  }
  const growth = samples[samples.length - 1]!.arrayBuffers - samples[0]!.arrayBuffers;
  // One native ESM evaluation owns the fixture buffer. Another copy per generation
  // means Node kept each captured module URL after the generation was released.
  expect(samples[samples.length - 1]!.evaluations).toBe(1);
  expect(samples[samples.length - 1]!.url).toBe(samples[0]!.url);
  expect(growth).toBeLessThan(NATIVE_ESM_BUFFER_BYTES);
  const refreshed = samples.filter((sample) => (sample.revision ?? -1) >= 2);
  expect(refreshed).toHaveLength(4);
  for (const sample of refreshed) {
    expect(sample.modelId).toBe("lazy-heap-model");
    expect(sample.laterEvaluations).toBe(1);
    expect(sample.lazyEvaluations).toBe(1);
    expect(
      sample.catalogModelIds.some(
        (id) => id === "lazy-heap-model" || id.endsWith("/lazy-heap-model"),
      ),
      sample.catalogModelIds.join(","),
    ).toBe(true);
  }
}, 180_000);

it("keeps a deferred native ESM import on the workspace that requested it", async () => {
  const fixture = await Promise.resolve(createCatalogFixture(makeTempDir, 0));
  const cjsEntry = fixture.config.plugins.load.paths[0];
  if (!cjsEntry) {
    throw new Error("catalog fixture did not register a plugin entry");
  }
  const pluginDir = path.dirname(cjsEntry);
  fs.rmSync(cjsEntry, { force: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ name: PLUGIN_ID, type: "module" }),
  );
  const entry = path.join(pluginDir, "index.js");
  fs.writeFileSync(
    path.join(pluginDir, "later.js"),
    `const state = globalThis[Symbol.for("openclaw.nativeEsmOwnerLater")] ??= { evaluations: 0 };
state.evaluations += 1;
export const modelId = "lazy-heap-model";
export const evaluations = state.evaluations;
`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "retired-side.js"),
    `const state = globalThis[Symbol.for("openclaw.nativeEsmOwnerRetired")] ??= { evaluations: 0 };
state.evaluations += 1;
export const modelId = "retired-side-model";
export const evaluations = state.evaluations;
`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "after.js"),
    `const state = globalThis[Symbol.for("openclaw.nativeEsmOwnerAfter")] ??= { evaluations: 0 };
state.evaluations += 1;
export const modelId = "after-heap-model";
export const evaluations = state.evaluations;
`,
  );
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
const state = globalThis[Symbol.for("openclaw.nativeEsmOwner")] ??= { evaluations: 0, catalogs: {} };
state.evaluations += 1;
function record(extra) {
  fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
    evaluations: state.evaluations,
    url: import.meta.url,
    ...extra,
  }) + "\\n");
}
record({ phase: "evaluate" });
export function register(api) {
  const role = String(api?.pluginConfig?.role ?? "");
  record({ phase: "register", role });
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER_ID)},
    label: "Heap fixture",
    auth: [],
    catalog: { async run() {
      const call = (state.catalogs[role] = (state.catalogs[role] ?? 0) + 1);
      let modelId = "heap-model";
      let laterEvaluations;
      let afterEvaluations;
      if (role === "allowed" && call >= 2) {
        const later = await import("./later.js");
        modelId = later.modelId;
        laterEvaluations = later.evaluations;
      }
      if (role === "allowed" && call >= 3) {
        const after = await import("./after.js");
        modelId = after.modelId;
        afterEvaluations = after.evaluations;
      }
      if (role === "neighbor" && call === 1) {
        let openGate;
        const gate = new Promise((resolve) => {
          openGate = resolve;
        });
        globalThis[Symbol.for("openclaw.nativeEsmStaleGate")] = openGate;
        globalThis[Symbol.for("openclaw.nativeEsmStaleImport")] = gate.then(() => import("./retired-side.js"));
      }
      let staleRejected = false;
      let staleEvaluations = 0;
      let staleError;
      if (role === "allowed" && call >= 4) {
        const openGate = globalThis[Symbol.for("openclaw.nativeEsmStaleGate")];
        if (typeof openGate === "function") {
          openGate();
        }
        try {
          const imported = await globalThis[Symbol.for("openclaw.nativeEsmStaleImport")];
          staleEvaluations = imported?.evaluations ?? 0;
          staleError = "loaded";
        } catch (error) {
          staleRejected = true;
          const message = error instanceof Error ? error.message : "";
          staleError = message.includes("no live workspace owner")
            ? "no-live-owner"
            : message.includes("was reloaded or disabled")
              ? "unavailable"
              : message.includes("Cannot find module")
                ? "missing-module"
                : error instanceof Error
                  ? error.name
                  : "rejected";
        }
      }
      record({ phase: "catalog", role, call, modelId, laterEvaluations, afterEvaluations, staleRejected, staleEvaluations, staleError });
      return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: modelId, name: "Heap model" }] } };
    } },
  });
}
`,
  );
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    configSchema?: { type?: string; properties?: Record<string, unknown> };
  };
  manifest.configSchema = {
    type: "object",
    ...manifest.configSchema,
    properties: { ...manifest.configSchema?.properties, role: { type: "string" } },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const baseConfig = {
    ...fixture.config,
    plugins: {
      ...fixture.config.plugins,
      load: { paths: [entry] },
    },
  };
  const metadata = loadPluginMetadataSnapshot({
    config: baseConfig,
    env: fixture.env,
    workspaceDir: fixture.workspaceDir,
  });
  const neighborWorkspace = path.join(fixture.root, "neighbor-workspace");
  const neighborAgent = path.join(fixture.root, "neighbor-agent");
  fs.mkdirSync(neighborWorkspace, { recursive: true });
  fs.mkdirSync(neighborAgent, { recursive: true });
  const workspaceInput = (workspace: {
    role: string;
    workspaceDir: string;
    agentDir: string;
    agentId: string;
  }) =>
    createPreparedModelCatalogWorkerInput({
      agentFacts: {
        input: {
          agentId: workspace.agentId,
          agentDir: workspace.agentDir,
          inheritedAuthDir: workspace.agentDir,
          workspaceDir: workspace.workspaceDir,
          config: {
            ...baseConfig,
            plugins: {
              ...baseConfig.plugins,
              entries: { [PLUGIN_ID]: { enabled: true, config: { role: workspace.role } } },
            },
            models: {
              providers: {
                [PROVIDER_ID]: {
                  baseUrl: "https://owner.invalid/v1",
                  api: "openai-completions" as const,
                  models: [],
                },
              },
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
      pluginMetadataSnapshot: metadata,
    });
  const allowed = workspaceInput({
    role: "allowed",
    workspaceDir: fixture.workspaceDir,
    agentDir: fixture.agentDir,
    agentId: "main",
  });
  const neighbor = workspaceInput({
    role: "neighbor",
    workspaceDir: neighborWorkspace,
    agentDir: neighborAgent,
    agentId: "neighbor",
  });
  const captureDir = makeTempDir("openclaw-catalog-owner-captures-");
  const captureFiles = (dir: string): string[] => {
    const found: string[] = [];
    const pending = [dir];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) {
        continue;
      }
      for (const child of fs.readdirSync(current, { withFileTypes: true })) {
        if (child.isSymbolicLink()) {
          continue;
        }
        const childPath = path.join(current, child.name);
        if (child.isDirectory()) {
          pending.push(childPath);
        } else {
          found.push(path.relative(dir, childPath));
        }
      }
    }
    return found.toSorted();
  };
  const pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
    workerOptions: {
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: {
        sourceCaptureDirectory: captureDir,
      },
      env: fixture.env,
    },
  });
  const run = async (value: PreparedModelCatalogWorkerTask["value"]) => {
    const result = await pool.run(
      {
        value,
        request: {
          kind: "catalog",
          syntheticAuth: [],
          clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
        },
      },
      { timeoutMs: 60_000 },
    );
    const catalogModelIds =
      result.status === "ok" && result.kind === "catalog"
        ? result.snapshot.entries.map((catalogEntry) => catalogEntry.id)
        : [];
    const rows = fs
      .readFileSync(fixture.marker, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            evaluations?: number;
            url?: string;
            phase?: string;
            role?: string;
            call?: number;
            modelId?: string;
            laterEvaluations?: number;
            afterEvaluations?: number;
            staleRejected?: boolean;
            staleEvaluations?: number;
            staleError?: string;
          },
      );
    return { result, catalogModelIds, latest: rows.at(-1) };
  };
  try {
    const first = await run(allowed);
    expect(first.result.status).toBe("ok");
    expect(first.latest?.modelId).toBe("heap-model");
    const neighborLive = await run(neighbor);
    expect(neighborLive.result.status).toBe("ok");
    const whileNeighborLives = await run(allowed);
    expect(whileNeighborLives.result.status).toBe("ok");
    expect(whileNeighborLives.latest?.modelId).toBe("lazy-heap-model");
    expect(whileNeighborLives.latest?.laterEvaluations).toBe(1);
    expect(whileNeighborLives.latest?.evaluations).toBe(1);
    const retired = await run({ ...neighbor, generationFingerprint: "stale-neighbor-generation" });
    expect(retired.result.status).toBe("generation-mismatch");
    const afterNeighborRetires = await run(allowed);
    expect(afterNeighborRetires.result.status).toBe("ok");
    expect(afterNeighborRetires.latest?.modelId).toBe("after-heap-model");
    expect(afterNeighborRetires.latest?.laterEvaluations).toBe(1);
    expect(afterNeighborRetires.latest?.afterEvaluations).toBe(1);
    expect(afterNeighborRetires.latest?.evaluations).toBe(1);
    expect(afterNeighborRetires.latest?.url).toBe(first.latest?.url);
    expect(
      afterNeighborRetires.catalogModelIds.some(
        (id) => id === "after-heap-model" || id.endsWith("/after-heap-model"),
      ),
    ).toBe(true);
    const captureBeforeStaleImport = captureFiles(captureDir);
    const staleImport = await run(allowed);
    expect(staleImport.result.status).toBe("ok");
    expect(staleImport.latest?.staleRejected).toBe(true);
    expect(staleImport.latest?.staleError).toBe("no-live-owner");
    expect(staleImport.latest?.staleEvaluations).toBe(0);
    expect(captureFiles(captureDir)).toEqual(captureBeforeStaleImport);
  } finally {
    await pool.close();
  }
}, 180_000);
