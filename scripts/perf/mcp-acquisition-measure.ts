// Run: node --import ./scripts/tsx.mjs scripts/perf/mcp-acquisition-measure.ts
// Add --allocation for a separate sampled-allocation pass. --base-dir <dir>
// loads saved base-manager.ts and base-install.ts through the same import graph.
// Measures 2,000 warm acquisitions after 100 warmups with 45 enabled native
// plugins declaring one MCP server each. Real manager/runtime admission runs;
// catalog discovery and tool execution do not (no child processes or network).
// Acceptance: fewer declaration loads, lower CPU/allocation, unchanged admission
// and reload behavior. This owner probe does not measure end-to-end chat latency.
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { PluginManifestRegistry } from "../../src/plugins/manifest-registry.js";

const { values } = parseArgs({
  options: { allocation: { type: "boolean" }, "base-dir": { type: "string" } },
});
const baseDir = values["base-dir"];
if (baseDir) {
  const replacements = new Map(
    ["manager", "install"].map((part) => [
      new URL(
        `../../src/agents/agent-bundle-mcp-${part === "manager" ? "manager" : "manager-install"}.ts`,
        import.meta.url,
      ).href,
      pathToFileURL(path.resolve(baseDir, `base-${part}.ts`)).href,
    ]),
  );
  registerHooks({
    load(url, context, nextLoad) {
      return nextLoad(replacements.get(url) ?? url, context);
    },
  });
}

const { createSessionMcpRuntimeManager } =
  await import("../../src/agents/agent-bundle-mcp-manager.js");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const scheduler = new GatewayScheduler();
const manager = createSessionMcpRuntimeManager({ scheduler });
const manifestRegistry: PluginManifestRegistry = {
  plugins: Array.from({ length: 45 }, (_, index) => ({
    id: `synthetic-${index}`,
    format: "openclaw",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "config",
    rootDir: `/synthetic/plugin-${index}`,
    source: `/synthetic/plugin-${index}/index.js`,
    manifestPath: `/synthetic/plugin-${index}/openclaw.plugin.json`,
    mcpServers: {
      [`server-${index}`]: { command: "unused-synthetic-mcp", args: ["--probe"] },
    },
  })),
  diagnostics: [],
};
const params = {
  sessionId: "synthetic-turn",
  sessionKey: "agent:main:synthetic-turn",
  workspaceDir: process.cwd(),
  manifestRegistry,
  cfg: {
    plugins: {
      entries: Object.fromEntries(
        manifestRegistry.plugins.map(({ id }) => [id, { enabled: true }]),
      ),
    },
  },
};
const first = await manager.acquire(params);
first.releaseLease();
async function acquire() {
  const lease = await manager.acquire(params);
  assert.equal(lease.runtime, first.runtime);
  lease.releaseLease();
}
const inspector = new Session();
try {
  for (let index = 0; index < 100; index++) {
    await acquire();
  }
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const samples: number[] = [];
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let index = 0; index < 2_000; index++) {
    const operationStart = performance.now();
    await acquire();
    samples.push(performance.now() - operationStart);
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  let sampledBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
    sampledBytes = bytes(profile.head);
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      revision: baseDir ? "base" : "candidate",
      mode: values.allocation ? "allocation" : "timing",
      operations: samples.length,
      plugins: manifestRegistry.plugins.length,
      wallMs,
      p50Ms: samples[Math.floor(samples.length * 0.5)],
      p95Ms: samples[Math.floor(samples.length * 0.95)],
      cpuUsPerOperation: (cpu.user + cpu.system) / samples.length,
      sampledBytesPerOperation:
        sampledBytes === undefined ? undefined : sampledBytes / samples.length,
      load: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
  await manager.disposeAll();
  await scheduler.stop();
}
