/**
 * Real session discovery request preparation + native MessagePort microbenchmark.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-discovery-payload-measure.mjs
 * Run on each revision. Five passes of 2,000 requests per operation, with separate
 * CPU/allocation passes and a 40-plugin synthetic config. The pool is replaced by
 * a native loopback port: measures host preparation, serialization and decoding,
 * not database execution or whole-Gateway latency. No production state is read.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { serialize } from "node:v8";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";

assert(globalThis.gc, "--expose-gc required");
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(path.resolve(".local/session-discovery-payload-"));
process.env.OPENCLAW_STATE_DIR = root;
const { withSessionHistoryWorkerReadCandidates, targetDiscoveryLane, rotateDatabaseWorkers } =
  await import("../../src/config/sessions/session-transcript-worker-resources.ts");
const config = {
  agents: {
    ownership: "explicit",
    entries: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`agent-${i}`, {}])),
  },
  acp: { defaultAgent: "acp", allowedAgents: ["acp"] },
  session: { store: path.join(root, "{agentId}.sqlite") },
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `plugin-${i}`,
        { enabled: true, config: { description: "synthetic-plugin-setting ".repeat(400) } },
      ]),
    ),
  },
  models: {
    providers: {
      mock: {
        baseUrl: "http://127.0.0.1:40001",
        models: Array.from({ length: 200 }, (_, i) => ({
          id: `model-${i}`,
          name: `Synthetic model ${i}`,
          contextWindow: 128000,
          maxTokens: 4096,
        })),
      },
    },
  },
};
const env = { OPENCLAW_STATE_DIR: root };
const requests = {
  inventory: { config, agentIds: [], env, paths: new Map(), registeredDatabases: [] },
  topology: {
    config,
    options: {
      includeIncognito: false,
      discovery: {
        env,
        snapshot: { retainedDeletions: { status: "empty" }, registeredAgentDatabases: [] },
      },
    },
  },
};
const replies = {
  "session-target-inventory": { kind: "session-target-inventory", agents: [] },
  "combined-store-topology": {
    kind: "combined-store-topology",
    prepared: { projection: "list", targets: {}, reads: [] },
  },
};
const channel = new MessageChannel();
let postCpuMicros = 0;
let wireBytes;
const original = targetDiscoveryLane.pool.run;
targetDiscoveryLane.pool.run = async (prepare) => {
  const input = typeof prepare === "function" ? prepare() : prepare;
  if (wireBytes === undefined) {
    wireBytes = serialize(input).byteLength;
  }
  const cpu = process.threadCpuUsage();
  channel.port1.postMessage(input);
  const used = process.threadCpuUsage(cpu);
  postCpuMicros += used.user + used.system;
  const received = receiveMessageOnPort(channel.port2).message;
  assert.deepEqual(received.request.config.agents, config.agents);
  assert.deepEqual(received.request.config.acp, config.acp);
  assert.deepEqual(received.request.config.session, config.session);
  return { ok: true, value: replies[input.kind] };
};
const inspector = new Session();
inspector.connect();
const allocated = (node) =>
  node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
const rows = [];
try {
  await withSessionHistoryWorkerReadCandidates(
    [],
    async (scope) => {
      for (const kind of ["inventory", "topology"]) {
        const run = () =>
          kind === "inventory"
            ? scope.readTargetInventory(requests.inventory)
            : scope.readCombinedTopology(requests.topology);
        for (let i = 0; i < 100; i++) {
          await run();
        }
        for (const mode of ["cpu", "allocation"]) {
          for (let pass = 0; pass < 5; pass++) {
            globalThis.gc();
            if (mode === "allocation") {
              await inspector.post("HeapProfiler.startSampling", {
                samplingInterval: 32768,
                includeObjectsCollectedByMinorGC: true,
                includeObjectsCollectedByMajorGC: true,
              });
            }
            postCpuMicros = 0;
            wireBytes = undefined;
            const hostLoad = loadavg();
            const cpu = process.threadCpuUsage();
            const start = performance.now();
            const iterations = 2000;
            for (let i = 0; i < iterations; i++) {
              await run();
            }
            const elapsedMs = performance.now() - start;
            const used = process.threadCpuUsage(cpu);
            const sampledBytes =
              mode === "allocation"
                ? allocated((await inspector.post("HeapProfiler.stopSampling")).profile.head)
                : undefined;
            const row = {
              kind,
              mode,
              pass,
              iterations,
              hostLoad,
              wireBytes,
              postCpuMicros,
              cpuMicros: used.user + used.system,
              elapsedMs,
              sampledBytes,
            };
            rows.push(row);
            console.log(JSON.stringify(row));
          }
        }
      }
    },
    targetDiscoveryLane,
  );
} finally {
  inspector.disconnect();
  targetDiscoveryLane.pool.run = original;
  channel.port1.close();
  channel.port2.close();
  await rotateDatabaseWorkers(targetDiscoveryLane);
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ node: process.version, rows }));
