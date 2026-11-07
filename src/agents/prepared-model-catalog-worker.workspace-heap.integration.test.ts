import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { getPluginMetadataSnapshotCache } from "../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createPreparedModelCatalogWorker,
  getPreparedModelCatalogWorkerPoolSnapshot,
} from "./prepared-model-catalog-worker.js";
import {
  catalogAgentFacts,
  stubCatalogEnv,
} from "./prepared-model-catalog-worker.shared.test-support.js";
import {
  createCatalogFixture,
  PROVIDER_ID,
  writeFixtureFiles,
} from "./prepared-model-catalog-worker.test-support.js";
import type { PreparedModelCatalogWorkerTask } from "./prepared-model-catalog-worker.types.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, observeWorkers } = usePreparedCatalogWorkerFixtures();

it("bounds native ESM payloads across alternating unchanged loader workspaces", async () => {
  const { root, env, config, marker } = await createCatalogFixture(makeTempDir, 0);
  stubCatalogEnv(env);
  const plugin = path.join(root, "plugin");
  writeFixtureFiles(plugin, {
    "payload.mjs": `
export class CatalogWorkspacePayload {
  rows = Array.from({ length: 100_000 }, (_, index) => ({ index }));
  buffer = new Uint8Array(1024 * 1024);
}
export const payload = new CatalogWorkspacePayload();
`,
    "index.cjs": `
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
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      memory: process.memoryUsage(),
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
    "openclaw.plugin.json": {
      id: PROVIDER_ID,
      providers: [PROVIDER_ID],
      modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" }, runtimeAugment: true },
      configSchema: { type: "object", additionalProperties: false },
    },
  });
  const inventories: ReturnType<typeof loadPluginMetadataSnapshot>[] = [];
  let metadataTransfers = 0;
  const observer = observeWorkers((worker) => {
    const post = worker.postMessage.bind(worker);
    vi.spyOn(worker, "postMessage").mockImplementation((message, ...rest) => {
      // The real worker transport owns this private envelope; retain counts, not its payload.
      const task = (message as { input?: PreparedModelCatalogWorkerTask }).input;
      if (task?.value && "pluginMetadataSnapshot" in task.value) {
        metadataTransfers++;
      }
      post(message, ...rest);
    });
  });
  observer.subscribe();
  const workers = ["one", "two"].map((agentId) => {
    const workspaceDir = path.join(root, `workspace-${agentId}`);
    const agentDir = path.join(env.OPENCLAW_STATE_DIR!, "agents", agentId, "agent");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const retirement = new AbortController();
    retireAfterTest(() => retirement.abort());
    const metadata = loadPluginMetadataSnapshot({
      config,
      env: process.env,
      workspaceDir,
    });
    inventories.push(metadata);
    return createPreparedModelCatalogWorker({
      agentFacts: catalogAgentFacts(
        {
          agentId,
          agentDir,
          workspaceDir,
          config,
          allowGatewaySubagentBinding: true,
        },
        process.env,
        {
          authStore: {
            version: 1,
            profiles: {
              fixture: { type: "api_key", provider: PROVIDER_ID, key: `synthetic-${agentId}` },
            },
          },
          providerIds: [PROVIDER_ID],
        },
      ),
      pluginMetadataSnapshot: metadata,
      isCurrent: () => !retirement.signal.aborted,
      retirementSignal: retirement.signal,
    });
  });
  expect(inventories[0]!.workspaceDir).not.toBe(inventories[1]!.workspaceDir);
  expect(getPluginMetadataSnapshotCache(inventories[0]!)).toBe(
    getPluginMetadataSnapshotCache(inventories[1]!),
  );
  const samples: Array<{
    memory: NodeJS.MemoryUsage;
    payloads: number;
    callbacks: number;
    threadId: number;
  }> = [];
  for (let turn = 0; turn < 20; turn++) {
    const result = await workers[turn % workers.length]!.loadCatalog();
    const pool = getPreparedModelCatalogWorkerPoolSnapshot();
    expect(pool).toMatchObject({ workers: 1, workersCreated: 1 });
    const entry = { id: "workspace-model", name: `synthetic-${turn % 2 ? "two" : "one"}` };
    expect(result.modelCatalog.entries).toContainEqual(expect.objectContaining(entry));
    samples.push(JSON.parse(fs.readFileSync(marker, "utf8")));
  }
  const last = samples.at(-1)!;
  expect(last).toMatchObject({ threadId: samples[0]!.threadId, payloads: 2, callbacks: 2 });
  expect(last.memory.heapUsed - samples[4]!.memory.heapUsed).toBeLessThan(16 * 1024 * 1024);
  expect(last.memory.arrayBuffers - samples[4]!.memory.arrayBuffers).toBeLessThan(2 * 1024 * 1024);
  expect(metadataTransfers).toBe(workers.length);
  observer.close();
}, 30_000);
