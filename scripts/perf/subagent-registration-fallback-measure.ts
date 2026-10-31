/**
 * Real registration reader, 19,500 synthetic persisted runs, one selected child.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-registration-fallback-measure.ts \
 *   --mode retention --output .local/registration-fallback/candidate.json
 * Repeat separate processes with --mode cpu and --mode allocation --iterations 3000.
 * --source-dir <sparse-base-root> overrides only subagent-registry-state.ts.
 * CPU/allocation measures preparation plus the three reads made during registration;
 * fixture creation, cache warming and forced GC are outside measured windows.
 * Retention keeps the reader after retiring its cache, then drops it for a GC control.
 * Accept released unrelated rows; report any capture CPU/allocation cost explicitly.
 * This is owner evidence, not a Gateway stress test. State stays beside --output.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "retention" },
    output: { type: "string" },
    "source-dir": { type: "string" },
    runs: { type: "string", default: "19500" },
    iterations: { type: "string", default: "3000" },
  },
});
assert(values.output && ["retention", "cpu", "allocation"].includes(values.mode));
assert(global.gc, "Run with --expose-gc");
const gc = global.gc;
const count = (name: "runs" | "iterations", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], label: name, min: 2, fallback });
const runs = count("runs", 19500);
const iterations = count("iterations", 3000);
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const root = await mkdtemp(path.join(path.dirname(output), "state-"));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = "1";
await writeFile(process.env.OPENCLAW_CONFIG_PATH, "{}\n");
const relativeOwner = "src/agents/subagents/registry/subagent-registry-state.ts";
const ownerUrl = new URL(`../../${relativeOwner}`, import.meta.url);
const sourceFile = values["source-dir"]
  ? path.resolve(values["source-dir"], relativeOwner)
  : fileURLToPath(ownerUrl);
let overrideLoaded = false;
if (values["source-dir"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl.href) {
        return nextLoad(url, context);
      }
      overrideLoaded = true;
      const loaded = nextLoad(pathToFileURL(sourceFile).href, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
}
const {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  prepareSubagentRegistrationRows,
} = await import("../../src/agents/subagents/registry/subagent-registry-state.js");
const { saveSubagentRegistryToSqlite } =
  await import("../../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { captureOpenClawStateWorkerContext } =
  await import("../../src/state/openclaw-state-worker-context.js");
assert(!values["source-dir"] || overrideLoaded, "Baseline override was not loaded");
const selected = "synthetic-0";
const child = `agent:main:subagent:${selected}`;
function seed() {
  const rows = new Map<string, SubagentRunRecord>();
  for (let index = 0; index < runs; index++) {
    const runId = `synthetic-${index}`;
    rows.set(runId, {
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: `agent:main:requester-${index % 1300}`,
      requesterDisplayKey: "synthetic requester",
      task: `Synthetic completed task ${index}`,
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal", endedAt: 2 },
      completion: { required: false },
      cleanupCompletedAt: 3,
      delivery: { status: "not_required" },
    });
  }
  saveSubagentRegistryToSqlite(rows);
}
async function collect() {
  for (let index = 0; index < 3; index++) {
    await nextTurn();
    gc();
  }
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, childNode) => sum + sampledBytes(childNode), 0);
}
try {
  seed();
  const context = captureOpenClawStateWorkerContext();
  const prepare = () => prepareSubagentRegistrationRows(child, [selected], context);
  let measurement: object;
  const hostLoad = loadavg();
  if (values.mode === "retention") {
    let reader: Awaited<ReturnType<typeof prepare>> | undefined = await prepare();
    const unrelated = Array.from(getSubagentRunsSnapshotForRead(new Map()))
      .filter(([id]) => id !== selected)
      .map(([, row]) => new WeakRef(row));
    const control = new WeakRef({});
    clearSubagentRunsReadCacheForTest();
    await collect();
    assert.equal(control.deref(), undefined);
    const retained = process.memoryUsage();
    const survivingUnrelatedRows = unrelated.filter((reference) => reference.deref()).length;
    assert.deepEqual([...reader().keys()], [selected]);
    reader = undefined;
    await collect();
    const released = process.memoryUsage();
    assert(unrelated.every((reference) => reference.deref() === undefined));
    measurement = {
      survivingUnrelatedRows,
      retainedHeapBytes: retained.heapUsed - released.heapUsed,
      retained,
      released,
    };
  } else {
    const pass = async () => {
      const reader = await prepare();
      return reader().size + reader().size + reader().size;
    };
    for (let index = 0; index < 20; index++) {
      assert.equal(await pass(), 3);
    }
    await collect();
    const inspector = new Session();
    let allocatedBytes: number | undefined;
    if (values.mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    let checksum = 0;
    for (let index = 0; index < iterations; index++) {
      checksum += await pass();
    }
    const elapsedMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    if (values.mode === "allocation") {
      allocatedBytes = sampledBytes(
        (await inspector.post("HeapProfiler.stopSampling")).profile.head,
      );
      inspector.disconnect();
    }
    assert.equal(checksum, iterations * 3);
    measurement = {
      iterations,
      elapsedMs,
      cpuUsPerCapture: (used.user + used.system) / iterations,
      sampledBytesPerCapture:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    };
  }
  const result = {
    mode: values.mode,
    runs,
    sourceSha256: hash("sha256", readFileSync(sourceFile), "hex"),
    node: process.version,
    hostLoad,
    hostLoadAfter: loadavg(),
    ...measurement,
  };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  clearSubagentRunsReadCacheForTest();
  await closeOpenClawStateDatabaseAsync();
  await rm(root, { recursive: true, force: true });
}
