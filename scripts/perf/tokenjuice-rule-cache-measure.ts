// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tokenjuice-rule-cache-measure.ts
// Alternate --owner baseline/head paths, five pairs plus A/A. Allocation is a separate run.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentToolResultMiddlewareEvent } from "../../src/plugins/agent-tool-result-middleware-types.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    calls: { type: "string", default: "2048" },
    worktrees: { type: "string", default: "2048" },
    allocation: { type: "boolean", default: false },
    startup: { type: "boolean", default: false },
    "first-capacity": { type: "boolean", default: false },
    output: { type: "string" },
  },
});
assert(global.gc, "Pass --expose-gc");
assert(!existsSync(join(homedir(), ".config/tokenjuice/rules")), "Use a host without user rules");
process.env.TOKENJUICE_STATS = "0";
process.env.TOKENJUICE_NO_OMISSION = "1";
const calls = Number(values.calls);
const worktrees = Number(values.worktrees);
assert(Number.isSafeInteger(calls) && calls > 0);
assert(Number.isSafeInteger(worktrees) && worktrees > 0);
const require = createRequire(new URL("../../extensions/tokenjuice/package.json", import.meta.url));
global.gc();
const importHeapBefore = process.memoryUsage().heapUsed;
const importCpuBefore = process.cpuUsage();
const importStarted = performance.now();
const {
  createTokenjuiceAgentToolResultMiddleware,
}: typeof import("../../extensions/tokenjuice/tool-result-middleware.js") = await import(
  values.owner
    ? pathToFileURL(values.owner).href
    : "../../extensions/tokenjuice/tool-result-middleware.js"
);
if (values.startup) {
  const elapsedMs = performance.now() - importStarted;
  const cpu = process.cpuUsage(importCpuBefore);
  global.gc();
  console.log(
    JSON.stringify({
      startup: true,
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      retainedBytes: process.memoryUsage().heapUsed - importHeapBefore,
    }),
  );
  process.exit(0);
}
const tokenjuiceUrl = pathToFileURL(require.resolve("tokenjuice")).href;
const { clearRuleCache }: { clearRuleCache?: () => void } = values["first-capacity"]
  ? {}
  : await import(tokenjuiceUrl);
const middleware = createTokenjuiceAgentToolResultMiddleware();
const event = (index: number): AgentToolResultMiddlewareEvent => ({
  toolCallId: "synthetic-rule-cache",
  toolName: "exec",
  args: { command: "git status", workdir: `/synthetic-tokenjuice/worktree-${index % worktrees}` },
  result: {
    content: [
      {
        type: "text",
        text: "On branch main\n\nChanges not staged for commit:\n\tmodified:   src/a.ts\n",
      },
    ],
    details: { status: "completed", exitCode: 0 },
  },
});
// Warm runtime compilation independently of cache cardinality, then drop fixture-owned rules.
if (!values["first-capacity"]) {
  for (let index = 0; index < 128; index++) {
    await middleware(event(0), { runtime: "openclaw" });
  }
  clearRuleCache?.();
}
global.gc();
const before = process.memoryUsage().heapUsed;
const hostLoad = loadavg();
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpuBefore = process.cpuUsage();
const started = performance.now();
let outputChars = 0;
let lastCallMs: number | undefined;
for (let index = 0; index < calls; index++) {
  const callStarted = values["first-capacity"] ? performance.now() : 0;
  const result = await middleware(event(index), { runtime: "openclaw" });
  if (values["first-capacity"]) {
    lastCallMs = performance.now() - callStarted;
  }
  const content = result?.result?.content;
  const first = content?.[0];
  assert(content?.length === 1 && first?.type === "text");
  outputChars += first.text.length;
}
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);
let allocatedBytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
  if (values.output) {
    await writeFile(values.output, JSON.stringify(profile));
  }
  inspector.disconnect();
}
global.gc();
const retainedBytes = process.memoryUsage().heapUsed - before;
(clearRuleCache ?? (await import(tokenjuiceUrl)).clearRuleCache)();
global.gc();
console.log(
  JSON.stringify({
    calls,
    worktrees,
    allocation: values.allocation,
    outputChars,
    hostLoad,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    retainedBytes,
    afterClearBytes: process.memoryUsage().heapUsed - before,
    allocatedBytes,
    lastCallMs,
  }),
);
