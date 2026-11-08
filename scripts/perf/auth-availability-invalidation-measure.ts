/**
 * Owner-decision microbenchmark; no provider calls, plugin loading, or Gateway RPCs.
 * Run each revision with a fresh process and isolated OPENCLAW_STATE_DIR:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/auth-availability-invalidation-measure.ts
 *   --mode timing --iterations 4000
 * Repeat with --mode allocation. Alternate base/candidate launches; compare absolute CPU and
 * sampled allocation per event. For a frozen baseline module in this checkout, pass --source
 * <file-adjacent-to-prepared-model-runtime-auth-publication.ts>; relative imports must stay valid.
 * The fixture has four configured owners and 40 plugin descriptors. It measures invalidation
 * decisions and retirement notifications only, including restoring a retired fixture owner to
 * a ready state for the next event. It does not model the much larger avoided plugin rebuilds.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { PreparedModelRuntimeOwner } from "../../src/agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "4000" },
    source: { type: "string" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(global.gc, "Run with --expose-gc");
assert(process.env.OPENCLAW_STATE_DIR, "Set an isolated OPENCLAW_STATE_DIR");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 4000,
});
const canonicalSource = fileURLToPath(
  new URL("../../src/agents/prepared-model-runtime-auth-publication.ts", import.meta.url),
);
const source = values.source ? path.resolve(values.source) : canonicalSource;
const { invalidatePreparedModelRuntimeOwnersForAuthMutation: invalidate } = (await import(
  pathToFileURL(source).href
)) as typeof import("../../src/agents/prepared-model-runtime-auth-publication.js");
const { normalizePreparedModelRuntimeInput, ownerKey, prepareModelRuntimeOwner } =
  await import("../../src/agents/prepared-model-runtime.owner.js");
const { capturePreparedModelRuntimeGeneration } =
  await import("../../src/agents/prepared-model-runtime.lifecycle.js");
const stateDir = path.resolve(process.env.OPENCLAW_STATE_DIR);
const env = { OPENCLAW_STATE_DIR: stateDir, HOME: stateDir };
const plugins = Array.from({ length: 40 }, (_, index) => `synthetic-${index}`);
const config: OpenClawConfig = {
  agents: {
    entries: Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [
        `synthetic-${index}`,
        {
          agentDir: path.join(stateDir, `agent-${index}`),
          workspace: path.join(stateDir, `workspace-${index}`),
        },
      ]),
    ),
  },
  plugins: {
    allow: plugins,
    entries: Object.fromEntries(plugins.map((id) => [id, { enabled: true }])),
  },
};
const owners = new Map<string, PreparedModelRuntimeOwner>();
let retirements = 0;
const observeRetirement = (owner: PreparedModelRuntimeOwner) => {
  capturePreparedModelRuntimeGeneration(owner).addEventListener("abort", () => retirements++, {
    once: true,
  });
};
for (const [agentId, agent] of Object.entries(config.agents!.entries!)) {
  const owner = prepareModelRuntimeOwner(
    normalizePreparedModelRuntimeInput({
      agentId,
      agentDir: agent.agentDir!,
      workspaceDir: agent.workspace,
      config,
      env,
    }),
    "configured",
    "static",
  );
  owner.needsRefresh = false;
  observeRetirement(owner);
  owners.set(ownerKey(owner.input), owner);
}
let invalidatedOwners = 0;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const result = invalidate(owners, {
      affectsInheritedStores: true,
      profileSetChanged: false,
      availabilityOnly: true,
    });
    invalidatedOwners += result.invalidatedOwners.length;
    for (const owner of result.invalidatedOwners) {
      // Fixture restoration only: actual publication/plugin preparation is deliberately excluded.
      owner.needsRefresh = false;
      owner.refreshError = undefined;
      observeRetirement(owner);
    }
  }
}
run(100);
invalidatedOwners = 0;
retirements = 0;
global.gc();
await nextTurn();
const inspector = new Session();
const gcDurations: number[] = [];
const observer = new PerformanceObserver((list) => {
  gcDurations.push(...list.getEntries().map((entry) => entry.duration));
});
try {
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoad = loadavg();
  const before = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  run(iterations);
  const elapsedMs = performance.now() - start;
  const cpuUsage = process.threadCpuUsage(cpu);
  const after = process.memoryUsage();
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  assert.equal(invalidatedOwners, retirements, "Every invalidated fixture generation must retire");
  global.gc();
  console.log(
    JSON.stringify({
      scope: "Auth availability invalidation owner only; excludes plugin loading and publication",
      mode: values.mode,
      sourceHash: createHash("sha256").update(readFileSync(source)).digest("hex"),
      node: process.version,
      iterations,
      owners: owners.size,
      configuredPlugins: plugins.length,
      invalidatedOwners,
      retirements,
      hostLoad,
      elapsedMs,
      mainThreadCpuMs: (cpuUsage.user + cpuUsage.system) / 1000,
      sampledBytes,
      bytesPerEvent: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      gc: {
        samples: gcDurations.length,
        totalMs: gcDurations.reduce((sum, ms) => sum + ms, 0),
        maxMs: Math.max(0, ...gcDurations),
      },
      memory: { before, after, retainedHeapBytes: process.memoryUsage().heapUsed },
    }),
  );
} finally {
  inspector.disconnect();
  observer.disconnect();
}
