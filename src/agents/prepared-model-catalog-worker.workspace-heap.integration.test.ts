import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { getPluginMetadataSnapshotCache } from "../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createPreparedModelCatalogWorker,
  getPreparedModelCatalogWorkerPoolSnapshot,
} from "./prepared-model-catalog-worker.js";
import { createCatalogFixture, PROVIDER_ID } from "./prepared-model-catalog-worker.test-support.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

it("bounds native ESM payloads across alternating unchanged loader workspaces", async () => {
  const fixture = createCatalogFixture(makeTempDir, 0);
  for (const key of [
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_WORKER_CATALOG_MARKER",
    "OPENCLAW_WORKER_EXTERNAL_AUTH_PATH",
    "OPENCLAW_WORKER_REF_ONLY_API_KEY",
    "OPENCLAW_WORKER_REF_ONLY_TOKEN",
  ] as const) {
    vi.stubEnv(key, fixture.env[key]);
  }
  const plugin = path.join(fixture.root, "plugin");
  fs.writeFileSync(
    path.join(plugin, "payload.mjs"),
    `
export class CatalogWorkspacePayload {
  rows = Array.from({ length: 100_000 }, (_, index) => ({ index }));
  buffer = new Uint8Array(1024 * 1024);
}
export const payload = new CatalogWorkspacePayload();
`,
  );
  fs.writeFileSync(
    path.join(plugin, "index.cjs"),
    `
const { payload } = require("./payload.mjs");
const v8 = require("node:v8");
const fs = require("node:fs");
const state = globalThis[Symbol.for("catalog.workspace.memory.proof")] ??= { payloads: [], callbacks: [], calls: 0 };
state.payloads.push(new WeakRef(payload));
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  const run = (ctx) => {
    if (payload.rows[99_999].index !== 99_999) throw Error("native module unavailable");
    state.calls++;
    if (state.calls === 1 || state.calls === 5 || state.calls === 20) v8.queryObjects(WeakRef);
    const memory = process.memoryUsage();
    fs.writeFileSync(${JSON.stringify(fixture.marker)}, JSON.stringify({
      calls: state.calls, memory,
      payloads: state.payloads.filter(ref => ref.deref()).length,
      callbacks: state.callbacks.filter(ref => ref.deref()).length,
      threadId: require("node:worker_threads").threadId,
    }));
    return { provider: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1", models: [{id:"workspace-model",name:ctx.resolveProviderApiKey(${JSON.stringify(PROVIDER_ID)}).apiKey}] } };
  };
  state.callbacks.push(new WeakRef(run));
  api.registerProvider({id:${JSON.stringify(PROVIDER_ID)},label:"Workspace fixture",auth:[],catalog:{run}});
} };
`,
  );
  fs.writeFileSync(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({
      id: PROVIDER_ID,
      providers: [PROVIDER_ID],
      modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" }, runtimeAugment: true },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  const inventories: ReturnType<typeof loadPluginMetadataSnapshot>[] = [];
  const workers = ["one", "two"].map((agentId) => {
    const workspaceDir = path.join(fixture.root, `workspace-${agentId}`);
    const agentDir = path.join(fixture.env.OPENCLAW_STATE_DIR!, "agents", agentId, "agent");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const retirement = new AbortController();
    retireAfterTest(() => retirement.abort());
    const metadata = loadPluginMetadataSnapshot({
      config: fixture.config,
      env: process.env,
      workspaceDir,
    });
    inventories.push(metadata);
    return createPreparedModelCatalogWorker({
      agentFacts: {
        input: {
          agentId,
          agentDir,
          workspaceDir,
          config: fixture.config,
          allowGatewaySubagentBinding: true,
        },
        env: process.env,
        authStore: {
          version: 1,
          profiles: {
            fixture: { type: "api_key", provider: PROVIDER_ID, key: `synthetic-${agentId}` },
          },
        },
        credentials: {},
        templateAuthStorage: AuthStorage.inMemory({}),
        providerIds: [PROVIDER_ID],
        configuredModelRefs: [],
        configuredRuntimeModels: [],
        runtimeCapabilityModels: [],
        configuredGeneratedCatalogPluginIds: [],
      },
      pluginMetadataSnapshot: metadata,
      isCurrent: () => !retirement.signal.aborted,
      retirementSignal: retirement.signal,
    });
  });
  expect(inventories[0]!.workspaceDir).not.toBe(inventories[1]!.workspaceDir);
  expect(getPluginMetadataSnapshotCache(inventories[0]!)).toBe(
    getPluginMetadataSnapshotCache(inventories[1]!),
  );
  console.log(
    "Parent catalog inventory admission",
    JSON.stringify({ sameInventory: true, workspaceViews: inventories.length }),
  );
  const samples: Array<{
    memory: NodeJS.MemoryUsage;
    payloads: number;
    callbacks: number;
    threadId: number;
  }> = [];
  for (let turn = 0; turn < 20; turn++) {
    const result = await workers[turn % workers.length]!.loadCatalog();
    expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
      workers: 1,
      workersCreated: 1,
    });
    expect(result.modelCatalog.entries).toContainEqual(
      expect.objectContaining({
        id: "workspace-model",
        name: `synthetic-${turn % 2 ? "two" : "one"}`,
      }),
    );
    samples.push(JSON.parse(fs.readFileSync(fixture.marker, "utf8")));
  }
  console.log("Workspace heap samples", JSON.stringify(samples));
  expect(samples.at(-1)!.threadId).toBe(samples[0]!.threadId);
  expect(samples.at(-1)!.payloads).toBe(2);
  expect(samples.at(-1)!.callbacks).toBe(2);
  expect(samples.at(-1)!.memory.heapUsed - samples[4]!.memory.heapUsed).toBeLessThan(
    16 * 1024 * 1024,
  );
  expect(samples.at(-1)!.memory.arrayBuffers - samples[4]!.memory.arrayBuffers).toBeLessThan(
    2 * 1024 * 1024,
  );
}, 30_000);
