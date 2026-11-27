// Owner-only startup measurement on an offline team-shape-fixture.ts directory.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/chat-metadata-startup-measure.ts
//   --state-dir <synthetic fixture> [--owner <frozen module with resolving relative imports>]
// Run five interleaved A/A/B groups; timing and allocation are separate passes.
// The WebSocket startup/recovery contract is covered by server.chat-metadata-boundary.test.ts.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    owner: { type: "string", default: "src/gateway/server-methods/chat-metadata-runtime.ts" },
    iterations: { type: "string", default: "5000" },
  },
});
assert(values["state-dir"] && globalThis.gc, "Supply --state-dir and run with --expose-gc");
const root = path.resolve(values["state-dir"]);
const summary = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(summary.format, "openclaw-team-shape-v1");
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 5000,
});
const { captureRuntimeConfigAsyncReader } = await import("../../src/config/config.js");
const { PreparedModelRuntimeOwnerNotPublishedError } =
  await import("../../src/agents/prepared-model-runtime.errors.js");
const { createGatewayChatMetadataRuntime } = (await import(
  pathToFileURL(path.resolve(values.owner)).href
)) as typeof import("../../src/gateway/server-methods/chat-metadata-runtime.js");
const config = await captureRuntimeConfigAsyncReader()();
const runtime = createGatewayChatMetadataRuntime({
  getConfig: () => config,
  getContext: () => ({
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot: async () => {
      throw new Error("Startup metadata must not load a model catalog");
    },
    logGateway: { debug() {} },
  }),
  log: { warn() {} },
});
const inspector = new Session();
inspector.connect();
try {
  // Real attachment's catch-up captures an empty generation before model publication.
  await runtime.refresh();
  const run = async (count: number) => {
    let retryable = 0;
    let unavailable = 0;
    for (let index = 0; index < count; index++) {
      try {
        await runtime.read({ agentId: "main", includeModels: false });
        assert.fail("Metadata served before its owner published");
      } catch (error) {
        if (error instanceof PreparedModelRuntimeOwnerNotPublishedError) {
          retryable++;
        } else {
          assert(error instanceof Error && error.name === "ChatMetadataSnapshotUnavailableError");
          unavailable++;
        }
      }
    }
    return { retryable, unavailable };
  };
  await run(500);
  globalThis.gc();
  const cpuStart = process.threadCpuUsage();
  const start = performance.now();
  const outcomes = await run(iterations);
  const elapsedMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuStart);
  globalThis.gc();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await run(iterations);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  console.log(
    JSON.stringify({
      owner: values.owner,
      iterations,
      outcomes,
      elapsedMs,
      mainCpuMs: (cpu.user + cpu.system) / 1000,
      sampledAllocationBytes: sumSampledHeapBytes(profile.head),
      loadavg: loadavg(),
      fixture: {
        sessions: summary.sessionCount,
        agentDatabaseBytes: statSync(path.join(root, "agents/main/agent/openclaw-agent.sqlite"))
          .size,
        worktreeFiles: summary.worktreeFiles,
        worktreeBytes: summary.worktreeFiles * summary.worktreeFileBytes,
      },
    }),
  );
} finally {
  inspector.disconnect();
  await runtime.stop();
}
