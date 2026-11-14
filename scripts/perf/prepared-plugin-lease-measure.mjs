/**
 * Compare built prepared-plugin lease owners, excluding Gateway/model/network latency.
 * node --expose-gc scripts/perf/prepared-plugin-lease-measure.mjs --dist <built-dist>
 *   --arm base|candidate --overlap=false|true --mode timing|allocation|counts --output <report.json>
 * Defaults: 40 plugins, 4000 leases, 16 calls per lease, 200 warmup leases.
 * Base uses the former lease literal with that build's real generation-retention API;
 * candidate calls its actual built lease factory. Imports/setup are not measured.
 * Run timing and sampled allocation in separate processes; interleave base/candidate arms.
 * Report default-off and opted-in workloads separately. Counts inspects one held lease
 * through existing retentionSnapshot diagnostics, outside timing/allocation measurement.
 * This synthetic owner workload supplements lifecycle proofs; it does not exercise reload.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    dist: { type: "string" },
    arm: { type: "string" },
    mode: { type: "string", default: "timing" },
    overlap: { type: "string", default: "false" },
    output: { type: "string" },
    iterations: { type: "string", default: "4000" },
    warmup: { type: "string", default: "200" },
    plugins: { type: "string", default: "40" },
    calls: { type: "string", default: "16" },
  },
});
assert(values.dist && values.output);
assert(["base", "candidate"].includes(values.arm));
assert(["timing", "allocation", "counts"].includes(values.mode));
assert(["false", "true"].includes(values.overlap), "--overlap must be false or true");
const overlap = values.overlap === "true";
if (values.mode !== "counts") {
  assert(global.gc, "Run with --expose-gc");
  assert(
    typeof process.threadCpuUsage === "function",
    "A runtime with main-thread CPU accounting is required",
  );
}
const dist = path.resolve(values.dist);
const output = path.resolve(values.output);
const numeric = (name) => {
  const value = Number(values[name]);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
};
const iterations = numeric("iterations");
const warmup = numeric("warmup");
const plugins = numeric("plugins");
const calls = numeric("calls");
const entries = await readdir(dist);
const imports = [];
async function builtExport(prefix, name) {
  for (const filename of entries.filter(
    (file) => file.startsWith(prefix) && file.endsWith(".mjs"),
  )) {
    const file = path.join(dist, filename);
    const source = await readFile(file, "utf8");
    const exports = [...source.matchAll(/export\s*\{([^}]+)\}\s*;/g)].at(-1)?.[1];
    const alias = exports?.match(new RegExp(`(?:^|,)\\s*${name}\\s+as\\s+(\\w+)\\s*(?:,|$)`))?.[1];
    if (!alias) {
      continue;
    }
    const module = await import(pathToFileURL(file).href);
    assert.equal(typeof module[alias], "function", `${name} export`);
    imports.push({ name, file, sha256: createHash("sha256").update(source).digest("hex") });
    return module[alias];
  }
  throw new Error(`Cannot locate built ${name} in ${prefix}* under ${dist}`);
}
const PluginInstance = await builtExport("plugin-setup-module-", "PluginInstance");
const createRegistry = await builtExport("registry-empty-", "createEmptyPluginRegistry");
const ownGeneration = await builtExport(
  "prepared-model-runtime.plugin-lifetime-",
  "ownPreparedPluginGeneration",
);
const retainGeneration = await builtExport(
  "prepared-model-runtime.plugin-lifetime-",
  "retainPreparedPluginGeneration",
);
const createLease =
  values.arm === "candidate"
    ? await builtExport(
        "prepared-model-runtime.plugin-lifetime-",
        "createPreparedModelRuntimeLease",
      )
    : undefined;
const registry = createRegistry();
const instances = [];
const tools = [];
let observedCalls = 0;
for (let index = 0; index < plugins; index++) {
  const id = `lease-benchmark-${index}`;
  const record = {
    id,
    name: id,
    generationOverlap: overlap,
    enabled: true,
    status: "loaded",
    origin: "bundled",
    source: `/synthetic/${id}.js`,
  };
  registry.plugins.push(record);
  const instance = new PluginInstance(id, { record, registry });
  instances.push(instance);
  tools.push(
    instance.wrap(() => {
      observedCalls++;
      return index;
    }),
  );
  registry.tools.push({
    pluginId: id,
    names: [id],
    optional: false,
    factory: instance.wrap(() => []),
  });
}
const generation = {
  remoteCatalog: null,
  pluginMetadataSnapshot: {},
  pluginRegistry: registry,
  inlineProviderModels: [],
  configuredCatalogEntries: [],
};
const snapshot = { pluginRegistry: registry };
const releasePublication = ownGeneration(generation).retain();
const inspector = new Session();
async function run(count) {
  for (let operation = 0; operation < count; operation++) {
    const lease = createLease
      ? createLease(snapshot, generation)
      : {
          snapshot,
          pluginGeneration: generation,
          [Symbol.asyncDispose]: retainGeneration(generation),
        };
    const execute = () => {
      for (let call = 0; call < calls; call++) {
        const selected = (operation + call) % plugins;
        assert.equal(tools[selected](), selected);
      }
    };
    try {
      if (createLease) {
        lease.run(execute);
      } else {
        execute();
      }
    } finally {
      await lease[Symbol.asyncDispose]();
    }
    if (operation % 100 === 99) {
      await nextTurn();
    }
  }
}
function readHolds() {
  const byKind = {};
  const byReason = {};
  let total = 0;
  for (const instance of instances) {
    const retention = instance.retentionSnapshot({ includeOwners: false });
    assert.equal(retention.omitted, 0, "Count inspection must include every held reference");
    total += retention.total;
    for (const reference of retention.references) {
      byKind[reference.kind] = (byKind[reference.kind] ?? 0) + 1;
      byReason[reference.reason] = (byReason[reference.reason] ?? 0) + 1;
    }
  }
  return { total, byKind, byReason };
}

try {
  if (values.mode === "counts") {
    const before = readHolds();
    const lease = createLease
      ? createLease(snapshot, generation)
      : {
          snapshot,
          pluginGeneration: generation,
          [Symbol.asyncDispose]: retainGeneration(generation),
        };
    let held;
    try {
      held = readHolds();
      const execute = () => {
        for (let call = 0; call < calls; call++) {
          const selected = call % plugins;
          assert.equal(tools[selected](), selected);
        }
      };
      if (createLease) {
        lease.run(execute);
      } else {
        execute();
      }
    } finally {
      await lease[Symbol.asyncDispose]();
    }
    const after = readHolds();
    assert.equal(observedCalls, calls);
    assert.deepEqual(after, before);
    assert(
      instances.every(
        (instance) => instance.retainedWorkCount === 0 && !instance.hasRetainedConsumers,
      ),
    );
    const report = {
      scope: "One prepared lease: existing retention diagnostics, no timing/allocation measurement",
      arm: values.arm,
      overlap,
      workload: overlap ? "opted-in" : "default-off",
      mode: values.mode,
      node: process.version,
      dist,
      imports,
      iterations: 1,
      warmup: 0,
      plugins,
      callsPerLease: calls,
      observedCalls,
      counts: { before, held, after },
      verified: {
        toolIdentity: true,
        noResidualWorkOrConsumerHolds: true,
        zeroAdditionalConsumerHolds: (held.byKind.consumer ?? 0) === (before.byKind.consumer ?? 0),
      },
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report) + "\n");
  } else {
    await run(warmup);
    assert(
      instances.every(
        (instance) => instance.retainedWorkCount === 0 && !instance.hasRetainedConsumers,
      ),
    );
    await mkdir(path.dirname(output), { recursive: true });
    if (values.mode === "allocation") {
      inspector.connect();
    }
    global.gc();
    await nextTurn();
    const expectedCalls = iterations * calls;
    observedCalls = 0;
    let profile;
    const memoryBefore = process.memoryUsage();
    const hostLoadBefore = os.loadavg();
    const threadStart = process.threadCpuUsage();
    const processStart = process.cpuUsage();
    const startedAt = new Date().toISOString();
    const start = performance.now();
    if (values.mode === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    await run(iterations);
    if (values.mode === "allocation") {
      ({ profile } = await inspector.post("HeapProfiler.stopSampling"));
    }
    // Timing runs exclude the profiler; allocation-run clocks include observer overhead.
    const elapsedMs = performance.now() - start;
    const threadCpu = process.threadCpuUsage(threadStart);
    const processCpu = process.cpuUsage(processStart);
    const memoryAfter = process.memoryUsage();
    const hostLoadAfter = os.loadavg();
    assert.equal(observedCalls, expectedCalls);
    assert(
      instances.every(
        (instance) => instance.retainedWorkCount === 0 && !instance.hasRetainedConsumers,
      ),
    );
    let allocation;
    if (profile) {
      let bytes = 0;
      const visit = (node) => {
        bytes += node.selfSize;
        node.children.forEach(visit);
      };
      visit(profile.head);
      const profilePath = output.replace(/\.json$/, "") + ".heapprofile";
      await writeFile(profilePath, JSON.stringify(profile));
      allocation = {
        bytes,
        bytesPerLease: bytes / iterations,
        samplingInterval: 32768,
        includesCollectedObjects: true,
        profilePath,
      };
    }
    const threadMs = (threadCpu.user + threadCpu.system) / 1000;
    const report = {
      scope:
        "Prepared lease acquisition, exact-instance tool calls, and disposal; synthetic 40-plugin owner workload, no Gateway latency claim",
      arm: values.arm,
      overlap,
      workload: overlap ? "opted-in" : "default-off",
      mode: values.mode,
      node: process.version,
      dist,
      imports,
      startedAt,
      iterations,
      warmup,
      plugins,
      callsPerLease: calls,
      observedCalls,
      elapsedMs,
      mainThreadCpu: { ms: threadMs, usPerLease: (threadMs * 1000) / iterations },
      processCpu: { ms: (processCpu.user + processCpu.system) / 1000 },
      allocation,
      memoryBefore,
      memoryAfter,
      hostLoadBefore,
      hostLoadAfter,
      verified: { toolIdentity: true, noResidualWorkOrConsumerHolds: true },
    };
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report) + "\n");
  }
} finally {
  inspector.disconnect();
  await releasePublication();
}
