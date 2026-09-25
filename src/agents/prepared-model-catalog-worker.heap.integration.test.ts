import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createPreparedModelCatalogWorkerInput,
  type PreparedModelCatalogWorkerTask,
  type PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.js";
import { createCatalogFixture, PROVIDER_ID } from "./prepared-model-catalog-worker.test-support.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();

it("bounds catalog worker retention across repeated fleet preparations", async () => {
  const fixture = createCatalogFixture(makeTempDir, 0);
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
        controlCollected: state.control.deref() === undefined,
        heap: v8.getHeapStatistics().used_heap_size
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
  const workers: Worker[] = [];
  const events = channel("worker_threads");
  const record = (message: unknown) => {
    if (isRecord(message) && message.worker instanceof Worker) {
      workers.push(message.worker);
    }
  };
  events.subscribe(record);
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
  const started = performance.now();
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
      if ((index + 1) % 100 === 0 || index + 1 === count) {
        const worker = workers.find((candidate) => candidate.threadId !== -1)!;
        const heap = await worker.getHeapStatistics();
        console.log(
          JSON.stringify({
            preparations: index + 1,
            worker: worker.threadId,
            heapUsed: heap.used_heap_size,
            heapTotal: heap.total_heap_size,
            heapLimit: heap.heap_size_limit,
            rss: process.memoryUsage().rss,
            elapsedMs: performance.now() - started,
            retained: JSON.parse(fs.readFileSync(fixture.marker, "utf8")),
            hashes: [...hashes],
          }),
        );
      }
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
      heap: number;
    };
    expect(retained.controlCollected).toBe(true);
    expect(retained.callbacks).toBe(1);
  } finally {
    await pool.close();
    events.unsubscribe(record);
  }
}, 300_000);
