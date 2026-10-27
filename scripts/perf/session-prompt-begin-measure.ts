/**
 * Measures prompt-series initialization with a resident, synthetic SessionManager.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-prompt-begin-measure.ts
 *   --entries 4096 --iterations 3000 [--allocation] [--disabled]
 * Save the old session-prompt-state.ts with git show, then pass --baseline-source <file>
 * to load that exact owner at its original URL and use its eager entries contract.
 * Run timing and sampled-allocation passes separately, alternating revision order.
 * Preparation/warmup are excluded. This measures branch acquisition + begin, not
 * transcript hydration, writer contention, provider latency, or full Gateway startup.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CURRENT_SESSION_VERSION } from "../../src/config/sessions/version.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    entries: { type: "string", default: "4096" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
    disabled: { type: "boolean", default: false },
    "baseline-source": { type: "string" },
  },
});
const count = (name: "entries" | "iterations", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback });
const entryCount = count("entries", 4096);
const iterations = count("iterations", 3000);
const ownerUrl = new URL(
  "../../src/agents/embedded-agent-runner/session-prompt-state.ts",
  import.meta.url,
).href;
let loadedBaseline = false;
if (values["baseline-source"]) {
  const baselineUrl = pathToFileURL(path.resolve(values["baseline-source"])).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl) {
        return nextLoad(url, context);
      }
      loadedBaseline = true;
      const result = nextLoad(baselineUrl, context);
      return { format: result.format, source: result.source, shortCircuit: true };
    },
  });
}
const { beginSessionSystemPrompt, retainEmbeddedSessionPromptState } =
  await import("../../src/agents/embedded-agent-runner/session-prompt-state.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
assert.equal(loadedBaseline, Boolean(values["baseline-source"]));
const manager = SessionManager.fromEntries([
  {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "synthetic-prompt-begin",
    timestamp: "2026-10-01T00:00:00Z",
    cwd: "/synthetic",
  },
  ...Array.from({ length: entryCount }, (_, index) => ({
    type: "message",
    id: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    timestamp: "2026-10-01T00:00:00Z",
    message: {
      role: "user",
      content: `Synthetic history ${index}. ${"x".repeat(256)}`,
      timestamp: index,
    },
  })),
]);
assert.equal(manager.getBranch().length, entryCount);
const lease = retainEmbeddedSessionPromptState("synthetic-prompt-begin");
let branchReads = 0;
const getEntries = () => {
  branchReads++;
  return manager.getBranch();
};
function runOne() {
  const params = {
    state: lease.state,
    routeKey: "synthetic-route",
    enabled: !values.disabled,
    entries: values["baseline-source"] ? getEntries() : undefined,
    getEntries: () => getEntries(),
  };
  return beginSessionSystemPrompt(params);
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
const inspector = new Session();
try {
  for (let index = 0; index < 200; index++) {
    assert.equal(runOne(), false);
  }
  branchReads = 0;
  globalThis.gc?.();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  let retirements = 0;
  for (let index = 0; index < iterations; index++) {
    retirements += Number(runOne());
  }
  const elapsedMs = performance.now() - start;
  const usedCpu = process.threadCpuUsage(cpu);
  const allocatedBytes = values.allocation
    ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  assert.equal(retirements, 0);
  assert.equal(branchReads, values["baseline-source"] || values.disabled ? iterations : 0);
  console.log(
    JSON.stringify({
      revision: values["baseline-source"] ? "base" : "candidate",
      mode: values.allocation ? "allocation" : "timing",
      enabled: !values.disabled,
      entryCount,
      iterations,
      branchReads,
      elapsedMs,
      cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      allocatedBytes,
      hostLoad,
      node: process.version,
    }),
  );
} finally {
  inspector.disconnect();
  lease[Symbol.dispose]();
}
