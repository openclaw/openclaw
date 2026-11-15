/**
 * Retained error owner proof; synthetic closure contexts contain 10k sessions and 40 plugins.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/long-lived-error-stacks-measure.ts
 *   --owner supervisor|cron|sqlite-latch|catalog-backoff|matrix-stop
 *   --mode timing|allocation|heap [--iterations 3000] [--records 16]
 *   [--base-dir /absolute/base-source] [--assert-collected]
 * Base source contains the original owner at its repository-relative path, plus
 * src/infra/error-graph-internal.ts. Alternate base/candidate launches. Timing and
 * sampled allocations exclude fixture construction; heap mode gives each held owner
 * its own fixture, then measures after GC. The supervisor uses a synthetic child
 * adapter that fails extinction; all supervisor lifecycle and error retention are real.
 * This is an owner benchmark, not a Gateway load test. No live state or processes.
 * The three cache owners also capture an 8 MiB buffer per fixture. --assert-collected
 * makes heap mode a retention regression: owners stay alive, caller fixtures must not.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "supervisor" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    records: { type: "string", default: "16" },
    "base-dir": { type: "string" },
    "assert-collected": { type: "boolean", default: false },
  },
});
const ownerPaths = {
  supervisor: "src/process/supervisor/supervisor.ts",
  cron: "src/gateway/cron-creator-authority-grant.ts",
  "sqlite-latch": "src/infra/sqlite-terminal-open-latch.ts",
  "catalog-backoff": "extensions/codex/src/session-catalog-source-backoff.ts",
  "matrix-stop": "extensions/matrix/src/matrix/sdk/crypto-store-lifecycle.ts",
};
assert(Object.hasOwn(ownerPaths, values.owner), "Invalid --owner");
assert(["timing", "allocation", "heap"].includes(values.mode), "Invalid --mode");
const iterations = Number(values.iterations);
const records = Number(values.records);
assert(Number.isSafeInteger(iterations) && iterations > 0, "Invalid --iterations");
assert(Number.isSafeInteger(records) && records > 0, "Invalid --records");
assert(typeof global.gc === "function", "Run with --expose-gc");
const ownerPath = ownerPaths[values.owner as keyof typeof ownerPaths];
const replacements = new Map<string, string>();
if (values["base-dir"]) {
  for (const relative of [
    ownerPath,
    "src/infra/error-graph-internal.ts",
    ...(values.owner === "catalog-backoff"
      ? ["extensions/codex/src/app-server/spawn-error.ts"]
      : []),
  ]) {
    const replacement = path.resolve(values["base-dir"], relative);
    assert(fs.existsSync(replacement), `Missing baseline source: ${relative}`);
    replacements.set(new URL(`../../${relative}`, import.meta.url).href, replacement);
  }
}
const loadedReplacements = new Set<string>();
const childAdapterUrl = new URL("../../src/process/supervisor/adapters/child.ts", import.meta.url)
  .href;
const adapterErrorKey = Symbol.for("openclaw.perf.long-lived-error-stacks.child-error");
registerHooks({
  resolve(specifier, context, nextResolve) {
    // Exercise the candidate SDK seam without requiring a second built distribution.
    if (specifier === "openclaw/plugin-sdk/error-runtime") {
      return nextResolve(
        new URL("../../src/plugin-sdk/error-runtime.ts", import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === childAdapterUrl) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export async function createChildAdapter() {
          const error = globalThis[Symbol.for("openclaw.perf.long-lived-error-stacks.child-error")];
          return { ready: Promise.resolve(), adapter: {
            pid: 0, onStdout() {}, onStderr() {}, kill() {}, dispose() {},
            wait: async () => ({code: 0, signal: null}),
            waitForExtinction: async () => { throw error; }
          }};
        }`,
      };
    }
    const replacement = replacements.get(url);
    if (replacement) {
      loadedReplacements.add(url);
      const loaded = nextLoad(pathToFileURL(replacement).href, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

function createFixture() {
  return {
    buffer:
      values.owner === "supervisor" || values.owner === "cron"
        ? undefined
        : Buffer.alloc(8 * 1024 * 1024, 1),
    sessions: Array.from({ length: 10_000 }, (_, index) => ({
      key: `agent:fixture:subagent:${index}`,
      title: `Finished synthetic session ${index}`,
      archived: index % 4 === 0,
      runId: `fixture-run-${index}`,
    })),
    plugins: Array.from({ length: 40 }, (_, index) => ({
      id: `fixture-plugin-${index}`,
      tools: [`tool-${index}`],
    })),
  };
}
type Fixture = ReturnType<typeof createFixture>;
type HeldRecord = { holder: object; fixture: WeakRef<Fixture> };
const noop = () => {};
const zero = () => 0;
let retain: (fixture: Fixture) => Promise<HeldRecord>;
if (values.owner === "supervisor") {
  const { createProcessSupervisor } = await import("../../src/process/supervisor/supervisor.js");
  retain = async (fixture) => {
    function failCleanup() {
      assert.equal(fixture.sessions.length, 10_000);
      return Object.assign(new Error("Synthetic cleanup failure"), { code: "FIXTURE_CLEANUP" });
    }
    const error = failCleanup();
    const supervisor = createProcessSupervisor();
    Reflect.set(globalThis, adapterErrorKey, error);
    const run = await supervisor.spawn({ mode: "child", argv: ["synthetic-only"] });
    Reflect.deleteProperty(globalThis, adapterErrorKey);
    await run.wait();
    await run.waitForExtinction!().then(
      () => assert.fail("Expected cleanup failure"),
      (failure: unknown) => assert.equal(failure, error),
    );
    return { holder: supervisor, fixture: new WeakRef(fixture) };
  };
} else if (values.owner === "cron") {
  const { createCronCreatorAuthorityRunScope } =
    await import("../../src/gateway/cron-creator-authority-grant.js");
  retain = async (fixture) => {
    const scope = createCronCreatorAuthorityRunScope("fixture-run", { kind: "local" });
    function revokeAuthority() {
      assert.equal(fixture.plugins.length, 40);
      scope.abort();
    }
    revokeAuthority();
    const reason: unknown = scope.signal.reason;
    assert(reason instanceof TypeError);
    assert.equal(reason.name, "CronCreatorAuthorityExpiredError");
    assert.equal(Reflect.get(reason, "status"), 403);
    return { holder: scope.signal, fixture: new WeakRef(fixture) };
  };
} else if (values.owner === "sqlite-latch") {
  const { createSqliteTerminalOpenLatch } =
    await import("../../src/infra/sqlite-terminal-open-latch.js");
  retain = async (fixture) => {
    const latch = createSqliteTerminalOpenLatch({ closeByPath: noop });
    function failOpen() {
      assert.equal(fixture.buffer?.byteLength, 8 * 1024 * 1024);
      return new Error("Synthetic nested open failure");
    }
    const nested = failOpen();
    const error = Object.assign(new AggregateError([nested], "Synthetic terminal open failure"), {
      code: "SQLITE_CORRUPT",
    });
    latch.record("synthetic.sqlite", error);
    assert.equal(latch.get("synthetic.sqlite"), error);
    assert.equal(error.code, "SQLITE_CORRUPT");
    assert.equal(error.message, "Synthetic terminal open failure");
    assert.equal(error.errors[0], nested);
    return { holder: latch, fixture: new WeakRef(fixture) };
  };
} else if (values.owner === "catalog-backoff") {
  const { CodexCatalogSourceBackoff } =
    await import("../../extensions/codex/src/session-catalog-source-backoff.js");
  retain = async (fixture) => {
    const backoff = new CodexCatalogSourceBackoff(zero);
    const config = {};
    function failCatalog() {
      assert.equal(fixture.buffer?.byteLength, 8 * 1024 * 1024);
      return Object.assign(new Error("Synthetic catalog failure"), { code: "FIXTURE_CATALOG" });
    }
    const error = failCatalog();
    for (let attempt = 0; attempt < 2; attempt++) {
      const permit = backoff.begin(config, "synthetic", "synthetic-home");
      assert(permit.allowed);
      permit.rejected(error);
    }
    const denied = backoff.begin(config, "synthetic", "synthetic-home");
    assert(!denied.allowed);
    assert.equal(denied.error, error);
    assert.equal(error.code, "FIXTURE_CATALOG");
    assert.equal(error.message, "Synthetic catalog failure");
    return { holder: { backoff, config }, fixture: new WeakRef(fixture) };
  };
} else {
  const { createMatrixSdkStopGate } =
    await import("../../extensions/matrix/src/matrix/sdk/crypto-store-lifecycle.js");
  retain = async (fixture) => {
    const gate = createMatrixSdkStopGate();
    function stopSdk() {
      assert.equal(fixture.buffer?.byteLength, 8 * 1024 * 1024);
      throw Object.assign(new Error("Synthetic Matrix stop failure"), { code: "FIXTURE_STOP" });
    }
    let original: unknown;
    try {
      gate.stop(stopSdk);
      assert.fail("Expected stop failure");
    } catch (error) {
      original = error;
    }
    assert(original instanceof Error);
    assert.equal(original.message, "Synthetic Matrix stop failure");
    assert.equal(Reflect.get(original, "code"), "FIXTURE_STOP");
    assert.equal(gate.stopped, true);
    assert.throws(
      () => gate.stop(() => assert.fail("SDK stop must not be retried")),
      (error) => error === original,
    );
    return { holder: gate, fixture: new WeakRef(fixture) };
  };
}
assert(
  !values["base-dir"] ||
    loadedReplacements.has(new URL(`../../${ownerPath}`, import.meta.url).href),
  "Baseline owner was not loaded",
);

async function collect() {
  for (let pass = 0; pass < 3; pass++) {
    await nextTurn();
    global.gc!();
  }
}

// Warm imports and the same ownership paths before measuring either arm.
for (let index = 0; index < 20; index++) {
  await retain(createFixture());
}
await collect();
const hostLoadBefore = loadavg();
if (values.mode === "heap") {
  const memoryBefore = process.memoryUsage();
  const heapBefore = memoryBefore.heapUsed;
  const held: HeldRecord[] = [];
  for (let index = 0; index < records; index++) {
    held.push(await retain(createFixture()));
  }
  await collect();
  const memoryAfter = process.memoryUsage();
  const heapAfter = memoryAfter.heapUsed;
  const retainedFixtures = held.filter((record) => record.fixture.deref() !== undefined).length;
  assert.equal(held.length, records);
  console.log(
    JSON.stringify({
      owner: values.owner,
      mode: values.mode,
      records,
      sessionsPerFixture: 10_000,
      pluginsPerFixture: 40,
      heapBefore,
      heapAfter,
      retainedBytes: heapAfter - heapBefore,
      retainedBytesPerRecord: (heapAfter - heapBefore) / records,
      retainedExternalBytes: memoryAfter.external - memoryBefore.external,
      retainedArrayBufferBytes: memoryAfter.arrayBuffers - memoryBefore.arrayBuffers,
      retainedFixtures,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
  if (values["assert-collected"]) {
    assert.equal(
      retainedFixtures,
      0,
      `${values.owner} retained caller fixtures through Error stacks`,
    );
  }
} else {
  const fixture = createFixture();
  const inspector = values.mode === "allocation" ? new Session() : undefined;
  try {
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    for (let index = 0; index < iterations; index++) {
      await retain(fixture);
    }
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const profile = inspector
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    const sampledBytes = profile?.samples.reduce((sum, sample) => sum + sample.size, 0);
    console.log(
      JSON.stringify({
        owner: values.owner,
        mode: values.mode,
        iterations,
        sessionsPerFixture: 10_000,
        pluginsPerFixture: 40,
        elapsedMs,
        cpuMs: (cpu.user + cpu.system) / 1000,
        cpuUsPerIteration: (cpu.user + cpu.system) / iterations,
        sampledBytes,
        sampledBytesPerIteration:
          sampledBytes === undefined ? undefined : sampledBytes / iterations,
        samples: profile?.samples.length,
        samplingInterval: inspector ? 4096 : undefined,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
        memory: process.memoryUsage(),
      }),
    );
  } finally {
    inspector?.disconnect();
  }
}
