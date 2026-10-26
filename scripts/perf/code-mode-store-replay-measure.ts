/**
 * Code Mode replay through the session-store owner, with synthetic committed entries.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/code-mode-store-replay-measure.ts \
 *   --entries 5000 --keys 200 --value-bytes 4096 --iterations 200
 *
 * Run five interleaved base/candidate pairs for 500/20, 2000/100, 5000/200 and
 * 10000/200 entries/keys, plus 500/4 at --value-bytes 262144. To compare just the
 * owner without another checkout, materialize `git show <base>:src/agents/code-mode-session-store.ts`
 * under .local and pass its path with --store-module. The native loader substitutes
 * both default and frozen source at the original URL, retaining the same dependency
 * closure and avoiding tsx/native-loader differences between comparison arms.
 * Native Node 26 total_allocated_bytes measures allocation without heap tracing.
 * Fixture construction, full-result verification and stringify instrumentation
 * are outside the measured replay loop. Every iteration binds a fresh catalog.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { ToolSearchCatalogRef } from "../../src/agents/tool-search-types.js";

const { values } = parseArgs({
  options: {
    "store-module": { type: "string" },
    entries: { type: "string", default: "5000" },
    keys: { type: "string", default: "200" },
    "value-bytes": { type: "string", default: "4096" },
    iterations: { type: "string", default: "200" },
  },
});
const entries = Number(values.entries);
const keys = Number(values.keys);
const valueBytes = Number(values["value-bytes"]);
const iterations = Number(values.iterations);
for (const value of [entries, keys, valueBytes, iterations]) {
  assert(Number.isSafeInteger(value) && value > 0, "Fixture arguments must be positive integers");
}
assert(
  valueBytes <= 256 * 1024 && valueBytes * keys <= 1024 * 1024,
  "Fixture exceeds store limits",
);
assert(
  Number.isFinite(getHeapStatistics().total_allocated_bytes),
  "Node 26 allocation counter required",
);
const ownerUrl = new URL("../../src/agents/code-mode-session-store.ts", import.meta.url);
const storeModule = values["store-module"] ? path.resolve(values["store-module"]) : ownerUrl;
const source = readFileSync(storeModule, "utf8");
let replaced = false;
registerHooks({
  load(url, context, nextLoad) {
    if (url === ownerUrl.href) {
      replaced = true;
      return { format: "module-typescript", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const {
  bindCodeModeSessionStore,
  createCodeModeSessionStoreAccess,
  disposeCodeModeSessionStore,
}: typeof import("../../src/agents/code-mode-session-store.js") = await import(ownerUrl.href);
assert(replaced, "Native owner source was not loaded");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const manager = SessionManager.inMemory();
const payloadBytes =
  valueBytes -
  JSON.stringify({ syntheticReplay: true, revision: "0000000000", payload: "" }).length;
assert(payloadBytes >= 0, "--value-bytes must fit the fixture envelope");
const payload = "x".repeat(payloadBytes);
const expected = new Map<string, { value: unknown; networkContent: boolean }>();
let sets = 0;
for (let index = 0; index < entries; index++) {
  const key = `key-${index % keys}`;
  const deleted = index % 11 === 10;
  const value = { syntheticReplay: true, revision: String(index).padStart(10, "0"), payload };
  const networkContent = index % 3 === 0;
  await manager.appendCustomEntryAsync("openclaw.code-mode-store", {
    set: deleted ? {} : { [key]: value },
    delete: deleted ? [key] : [],
    networkContent: deleted ? {} : { [key]: networkContent },
  });
  if (deleted) {
    expected.delete(key);
  } else {
    sets++;
    expected.set(key, { value, networkContent });
  }
}

function access() {
  const owner: ToolSearchCatalogRef = {
    current: {
      entries: [],
      counterScope: "replay-measure",
      searchCount: 0,
      describeCount: 0,
      callCount: 0,
    },
  };
  bindCodeModeSessionStore(owner, manager);
  const cell = createCodeModeSessionStoreAccess(
    { catalogRef: owner, sessionId: manager.getSessionId(), runId: "replay-measure" },
    new AbortController().signal,
  );
  return {
    cell,
    close() {
      cell.close();
      owner.current = undefined;
      disposeCodeModeSessionStore(owner);
    },
  };
}

async function replay() {
  const run = access();
  try {
    await run.cell.load("missing-key");
  } finally {
    run.close();
  }
}

const verified = access();
const checksum = createHash("sha256");
try {
  for (let index = 0; index < keys; index++) {
    const key = `key-${index}`;
    const result = await verified.cell.load(key);
    assert.deepEqual(result, expected.get(key) ?? { networkContent: false });
    checksum.update(JSON.stringify([key, result]));
  }
} finally {
  verified.close();
}
for (let warmup = 0; warmup < 5; warmup++) {
  await replay();
}
globalThis.gc?.();
await nextTurn();
const pauses: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    pauses.push(entry.duration);
  }
});
observer.observe({ entryTypes: ["gc"] });
const beforeMemory = process.memoryUsage();
const beforeLoad = loadavg();
const beforeAllocated = getHeapStatistics().total_allocated_bytes;
const beforeCpu = process.cpuUsage();
const beforeThreadCpu = process.threadCpuUsage();
const start = performance.now();
for (let index = 0; index < iterations; index++) {
  await replay();
}
const elapsedMs = performance.now() - start;
const threadCpu = process.threadCpuUsage(beforeThreadCpu);
const cpu = process.cpuUsage(beforeCpu);
const allocatedBytes = getHeapStatistics().total_allocated_bytes - beforeAllocated;
const afterMemory = process.memoryUsage();
await nextTurn();
await nextTurn();
observer.disconnect();

let stringifyCalls = 0;
let valueStringifies = 0;
const stringify = JSON.stringify;
JSON.stringify = (value: unknown, replacer, space) => {
  stringifyCalls++;
  if (
    value !== null &&
    typeof value === "object" &&
    "syntheticReplay" in value &&
    value.syntheticReplay === true
  ) {
    valueStringifies++;
  }
  return typeof replacer === "function"
    ? stringify(value, replacer, space)
    : stringify(value, replacer, space);
};
try {
  await replay();
} finally {
  JSON.stringify = stringify;
}
console.log(
  JSON.stringify({
    storeModule,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    entries,
    keys,
    valueBytes,
    sets,
    survivingKeys: expected.size,
    iterations,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
    allocatedBytes,
    allocatedBytesPerReplay: allocatedBytes / iterations,
    cpuMsPerReplay: (cpu.user + cpu.system) / 1000 / iterations,
    mainThreadCpuMsPerReplay: (threadCpu.user + threadCpu.system) / 1000 / iterations,
    stringifyCallsPerReplay: stringifyCalls,
    valueStringifiesPerReplay: valueStringifies,
    gcCount: pauses.length,
    gcTotalMs: pauses.reduce((sum, pause) => sum + pause, 0),
    gcMaxMs: Math.max(0, ...pauses),
    beforeMemory,
    afterMemory,
    hostLoad: { before: beforeLoad, after: loadavg() },
    checksum: checksum.digest("hex"),
  }),
);
