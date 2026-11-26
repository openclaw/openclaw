// Progress-card writes through the real worker with 10,000 synthetic session rows.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/progress-card-assertion-measure.mjs
//   --root <new-directory> --source <saved-progress-card-store.ts> --mode both|timing|allocation|count
// Run five interleaved baseline/candidate pairs. Acceptance: fewer caller assertions,
// lower allocation with identical revisions and no material CPU regression.
// Both mode times an untraced pass, then samples a separate allocation pass.
// Count mode instruments assertion entries separately from timing/allocation.
// The source guard uses two real composed session-source wrappers over synthetic
// live authority. This isolates composition cost; it is not full operator-policy
// authorization or a whole-Gateway throughput measurement.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    source: { type: "string", default: "src/gateway/progress-card-store.ts" },
    mode: { type: "string", default: "both" },
    iterations: { type: "string", default: "1000" },
    profile: { type: "string" },
  },
});
assert(values.root && global.gc, "Use --root and --expose-gc");
assert(["timing", "allocation", "both", "count"].includes(values.mode));
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = path.resolve(values.root);
fs.mkdirSync(root);
process.env.OPENCLAW_STATE_DIR = root;
const source = fs.readFileSync(values.source, "utf8");
let loaded = false;
const counts = { operation: 0, store: 0, owner: 0 };
const countKey = Symbol.for("openclaw.perf.agentAssertions");
globalThis[countKey] = counts;
registerHooks({
  load(url, context, nextLoad) {
    if (
      url.startsWith("file:") &&
      new URL(url).pathname.endsWith("/src/gateway/progress-card-store.ts")
    ) {
      loaded = true;
      const measured =
        values.mode === "count"
          ? source.replace(
              "const assertOwnerCurrent = () => {",
              'const assertOwnerCurrent = () => { globalThis[Symbol.for("openclaw.perf.agentAssertions")].owner++;',
            )
          : source;
      return { format: "module", source: stripTypeScriptTypes(measured), shortCircuit: true };
    }
    if (values.mode === "count" && url.startsWith("file:")) {
      const filename = new URL(url).pathname;
      const marker = filename.endsWith("/src/state/openclaw-agent-execution-native.ts")
        ? ["assertOperationCurrent", "operation"]
        : filename.endsWith("/src/state/openclaw-agent-worker-store.ts")
          ? ["assert", "store"]
          : undefined;
      if (marker) {
        const instrumented = fs
          .readFileSync(new URL(url), "utf8")
          .replace(
            `const ${marker[0]} = () => {`,
            `const ${marker[0]} = () => { globalThis[Symbol.for("openclaw.perf.agentAssertions")].${marker[1]}++;`,
          );
        return { format: "module", source: stripTypeScriptTypes(instrumented), shortCircuit: true };
      }
    }
    return nextLoad(url, context);
  },
});
const { applyLoggingConfig, flushLogger } = await import("../../src/logging/logger.ts");
applyLoggingConfig({
  level: "error",
  file: path.join(root, "measure.log"),
  consoleLevel: "silent",
});
const {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} = await import("../../src/state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts");
const { progressCardStore } = await import("../../src/gateway/progress-card-store.ts");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.ts");
const { composeSessionSourceAssertion } =
  await import("../../src/config/sessions/session-source-authority.ts");
setRuntimeConfigSnapshot({}, {});
assert(loaded, "Requested progress-card owner was not loaded");
const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: root } };
openOpenClawAgentDatabase(options);
runOpenClawAgentWriteTransaction((database) => {
  for (let i = 0; i < 10000; i++) {
    writeSessionEntry(database, `agent:main:session-${i}`, {
      sessionId: `synthetic-${i}`,
      updatedAt: i + 1,
    });
  }
}, options);
await closeOpenClawAgentDatabasesAsync();
let calls = 0;
const controller = new AbortController();
const sourceAuthority = composeSessionSourceAssertion([
  composeSessionSourceAssertion([() => controller.signal.throwIfAborted()]),
]);
const assertCurrent = () => {
  calls++;
  sourceAuthority();
};
let revision = 0;
const cycle = async () => {
  const result = await progressCardStore.put(
    "agent:main:session-42",
    {
      markdown: "Synthetic worker progress",
      assertCurrent,
    },
    "main",
  );
  assert.equal(result.card?.revision, ++revision);
};
const inspector = new Session();
try {
  for (let i = 0; i < 50; i++) {
    await cycle();
  }
  global.gc();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const started = performance.now();
  calls = 0;
  counts.operation = counts.store = counts.owner = 0;
  for (let i = 0; i < iterations; i++) {
    await cycle();
  }
  const elapsedMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(thread);
  const processCpu = process.cpuUsage(cpu);
  const callerAssertions = calls / iterations;
  let bytes;
  if (values.mode === "both") {
    global.gc();
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let i = 0; i < iterations; i++) {
      await cycle();
    }
  }
  if (values.mode === "allocation" || values.mode === "both") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node) =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    bytes = sum(profile.head) / iterations;
    if (values.profile) {
      fs.writeFileSync(values.profile, JSON.stringify(profile));
    }
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      iterations,
      sessions: 10000,
      callerAssertions,
      counts: values.mode === "count" ? counts : undefined,
      elapsedMs: elapsedMs / iterations,
      threadUs: (threadCpu.user + threadCpu.system) / iterations,
      processUs: (processCpu.user + processCpu.system) / iterations,
      bytes,
      load: loadavg(),
    }),
  );
} finally {
  delete globalThis[countKey];
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await flushLogger();
  fs.rmSync(root, { recursive: true, force: true });
}
