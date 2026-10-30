// Context-hook owner proof, not default Gateway traffic: 20 resident histories,
// each with 32 distinct 64 KiB tool results. A registered no-op hook sees a writable
// projection on every call. Compare identical serialized bytes outside timing.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/extension-context-copy-measure.ts
//   --output .local/context-candidate.json --iterations 2000 [--allocations]
// Add --owner-file <saved runner.ts> for baseline. Alternate arms; sample allocation
// separately from timing. --snapshot <path> captures the 20 retained projections
// after measurement; snapshot work and explicit GC are outside the timing window.
// For large-string census, pass --heap-snapshot-string-limit=131072 to Node
// and --string-limit 131072 to scripts/heap-snapshot-diff.mjs.
// Acceptance: reduced allocation/retention without material CPU regression;
// no transcript-byte changes and writable, detached hook containers.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { createExtensionRuntime } from "../../src/agents/sessions/extensions/loader.js";
import type { Extension } from "../../src/agents/sessions/extensions/types.js";
import type { ModelRegistry } from "../../src/agents/sessions/model-registry.js";
import type { SessionManager } from "../../src/agents/sessions/session-manager.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "owner-file": { type: "string" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
    snapshot: { type: "string" },
  },
});
assert(values.output, "--output is required");
assert(globalThis.gc, "--expose-gc is required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations >= 20);
const ownerUrl = new URL("../../src/agents/sessions/extensions/runner.ts", import.meta.url);
const sourceUrl = values["owner-file"] ? pathToFileURL(values["owner-file"]) : ownerUrl;
let ownerLoaded = false;
if (values["owner-file"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url === ownerUrl.href) {
        ownerLoaded = true;
        const loaded = nextLoad(sourceUrl.href, context);
        return { format: loaded.format, source: loaded.source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
const { ExtensionRunner } = await import("../../src/agents/sessions/extensions/runner.js");
assert(!values["owner-file"] || ownerLoaded, "Baseline substitution did not load");
const extensions = [
  {
    path: "/synthetic/context-hook.ts",
    handlers: new Map([["context", [async () => undefined]]]),
  },
] as Extension[];
// Context dispatch does not access persistence or the model catalog.
const runner = new ExtensionRunner(
  extensions,
  createExtensionRuntime(),
  "/synthetic",
  {} as SessionManager,
  {} as ModelRegistry,
);
const histories: AgentMessage[][] = Array.from({ length: 20 }, (_, session) =>
  Array.from({ length: 32 }, (_turnValue, turn) => ({
    role: "toolResult",
    toolCallId: `call-${session}-${turn}`,
    toolName: "synthetic",
    content: [
      {
        type: "text",
        text: Buffer.from(`synthetic-context-${session}-${turn}:`.padEnd(64 * 1024, "x")).toString(
          "utf8",
        ),
      },
    ],
    isError: false,
    timestamp: turn,
  })),
);
const golden = histories.map((messages) => hash("sha256", JSON.stringify(messages), "hex"));
const projections: AgentMessage[][] = [];
for (let index = 0; index < 40; index++) {
  projections[index % 20] = await runner.emitContext(histories[index % 20]!);
}
await setImmediate();
globalThis.gc();
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.threadCpuUsage();
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  const slot = index % 20;
  projections[slot] = await runner.emitContext(histories[slot]!);
}
const wallMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuStart);
let allocatedBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
await setImmediate();
globalThis.gc();
const memory = process.memoryUsage();
if (values.snapshot) {
  writeHeapSnapshot(values.snapshot);
}
for (let index = 0; index < histories.length; index++) {
  assert.equal(hash("sha256", JSON.stringify(projections[index]), "hex"), golden[index]);
  assert.notEqual(projections[index], histories[index]);
  const projected = projections[index]![0]!;
  const original = histories[index]![0]!;
  assert.notEqual(projected, original);
  assert(projected.role === "toolResult" && original.role === "toolResult");
  assert.notEqual(projected.content, original.content);
}
writeFileSync(
  values.output,
  JSON.stringify(
    {
      scope: "Registered context-hook owner; no default Gateway frequency claim",
      ownerSha256: hash("sha256", readFileSync(sourceUrl), "hex"),
      iterations,
      sessions: 20,
      messagesPerSession: 32,
      textBytesPerMessage: 65536,
      allocations: values.allocations,
      cpuMs: (cpu.user + cpu.system) / 1000,
      wallMs,
      allocatedBytes,
      bytesPerOperation: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      memory,
      hostLoad,
      hostLoadEnd: loadavg(),
      golden,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
