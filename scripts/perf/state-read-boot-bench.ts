/**
 * Synthetic startup reads through an already-built state-read owner:
 * node --expose-gc --import ./scripts/perf/team-shape-stress-loader.mjs \
 *   scripts/perf/state-read-boot-bench.ts \
 *   --build-root /path/to/revision --iterations 1000
 * Repeat with --allocations for sampled MAIN-ISOLATE allocation, including GC'd
 * objects. Compare timing only in untraced passes; alternate base/candidate runs.
 *
 * Four sequential awaited reads precede two concurrent retained reads, followed
 * by a separate warm phase. This deliberately exercises pool handoff; it is not
 * a recorded Gateway boot. Physical worker starts come from runtime telemetry,
 * including nested native workers. Process CPU includes all isolates; sampled
 * allocation does not. Whole-Gateway readiness/RSS proof remains separate.
 * Fixture creation/imports and final cleanup are outside both measured phases.
 * The fixture has 10,000 unrelated machine-state rows and 40 plugin descriptors.
 * All runtime functions load from the selected dist; generated files are untouched.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { hostname, loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type * as Roles from "../../src/infra/database-engine/admission-scope.js";
import type * as Diagnostics from "../../src/infra/worker-cpu.js";
import type * as Native from "../../src/infra/worker-native-lifecycle.js";
import type * as MachineState from "../../src/state/config-machine-state-write.js";
import type * as Reads from "../../src/state/openclaw-state-db-readonly.js";
import type * as State from "../../src/state/openclaw-state-db.js";
import type { OpenClawStateReadCommand } from "../../src/state/openclaw-state-read.types.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "build-root": { type: "string" },
    iterations: { type: "string", default: "1000" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values["build-root"], "--build-root is required");
assert(global.gc, "Run with --expose-gc");
const buildRoot = path.resolve(values["build-root"]);
const dist = path.join(buildRoot, "dist");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 1000,
});
const modules: Record<string, { file: string; sha256: string }> = {};

// tsdown exposes internal chunks with short aliases; resolve the explicit export,
// never infer an alias from a prior build or rewrite the generated module.
async function built<T>(prefix: string, name: string): Promise<T> {
  for (const file of readdirSync(dist)
    .filter((entry) => entry.startsWith(`${prefix}-`) && entry.endsWith(".mjs"))
    .toSorted()) {
    const source = readFileSync(path.join(dist, file), "utf8");
    for (const block of source.matchAll(/export\s*\{([^}]+)\};/g)) {
      // The matched export expression always includes its nonempty capture.
      const exported = block[1]!.split(",").map((part) => part.trim());
      const selected = exported.find((part) => part === name || part.startsWith(`${name} as `));
      if (!selected) {
        continue;
      }
      const alias = selected.split(/\s+as\s+/)[1] ?? name;
      const module: Record<string, unknown> = await import(
        pathToFileURL(path.join(dist, file)).href
      );
      assert.equal(typeof module[alias], "function", `${file}: ${name}`);
      modules[name] = { file, sha256: createHash("sha256").update(source).digest("hex") };
      return module[alias] as T;
    }
  }
  throw new Error(`Missing built export ${name} in ${dist}/${prefix}-*.mjs`);
}

const scratchParent = path.resolve(".local/state-read-boot-bench");
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(path.join(scratchParent, "run-"));
const environment = {
  HOME: path.join(scratch, "home"),
  OPENCLAW_HOME: path.join(scratch, "home"),
  OPENCLAW_STATE_DIR: path.join(scratch, "state"),
  OPENCLAW_CONFIG_PATH: path.join(scratch, "config.json"),
  TMPDIR: path.join(scratch, "tmp"),
};
for (const directory of [environment.HOME, environment.OPENCLAW_STATE_DIR, environment.TMPDIR]) {
  mkdirSync(directory, { recursive: true });
}
Object.assign(process.env, environment);

const installRole = await built<typeof Roles.installDatabaseProcessRole>(
  "admission-scope",
  "installDatabaseProcessRole",
);
const writeTransaction = await built<typeof State.runOpenClawStateWriteTransaction>(
  "openclaw-state-db",
  "runOpenClawStateWriteTransaction",
);
const writeMachineState = await built<typeof MachineState.writeConfigMachineStateInDatabase>(
  "config-machine-state-write",
  "writeConfigMachineStateInDatabase",
);
const close = await built<typeof State.closeOpenClawStateDatabaseAsync>(
  "openclaw-state-db-cache",
  "closeOpenClawStateDatabaseAsync",
);
const read = await built<typeof Reads.executeExistingOpenClawStateRead>(
  "openclaw-state-db-readonly",
  "executeExistingOpenClawStateRead",
);
const lifecycle = await built<typeof Diagnostics.getTrackedWorkerLifecycleSnapshot>(
  "worker-cpu",
  "getTrackedWorkerLifecycleSnapshot",
);
const closeNative = await built<typeof Native.closeDefaultRetainedNativeWorkerSource>(
  "worker-native-lifecycle",
  "closeDefaultRetainedNativeWorkerSource",
);
installRole("gateway");

async function measure(run: () => Promise<void>, operations: number) {
  global.gc!();
  await nextTurn();
  const inspector = new Session();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  try {
    const workersBefore = lifecycle().workerLifecycle;
    const memoryBefore = process.memoryUsage();
    const loadBefore = loadavg();
    const processCpuBefore = process.cpuUsage();
    const threadCpuBefore = process.threadCpuUsage();
    const start = performance.now();
    await run();
    const elapsedMs = performance.now() - start;
    const threadCpu = process.threadCpuUsage(threadCpuBefore);
    const processCpu = process.cpuUsage(processCpuBefore);
    const memoryAfter = process.memoryUsage();
    const allocatedBytes = values.allocations
      ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
    return {
      operations,
      elapsedMs,
      mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
      processCpuMs: (processCpu.user + processCpu.system) / 1000,
      mainSampledAllocatedBytes: allocatedBytes,
      mainSampledAllocatedBytesPerOperation:
        allocatedBytes === undefined ? undefined : allocatedBytes / operations,
      workersStarted: lifecycle()
        .workerLifecycle.map(({ script, started }) => ({
          script,
          count: started - (workersBefore.find((entry) => entry.script === script)?.started ?? 0),
        }))
        .filter(({ count }) => count > 0),
      memoryBefore,
      memoryAfter,
      loadBefore,
      loadAfter: loadavg(),
    };
  } finally {
    inspector.disconnect();
  }
}

try {
  writeTransaction(({ db }) => {
    for (let index = 0; index < 10_000; index++) {
      writeMachineState(db, `synthetic.${index}`, { value: index });
    }
    writeMachineState(
      db,
      "plugins.installedIndex",
      Array.from({ length: 40 }, (_, index) => ({ id: `synthetic-${index}` })),
    );
  });
  await close();
  const commands: OpenClawStateReadCommand[] = [
    { type: "config.health.read", input: undefined },
    {
      type: "plugins.metadata.read",
      input: { stateKeys: ["plugins.installedIndex", "plugins.bundledDiscovery"] },
    },
    { type: "restartLifecycle.readHandoff", input: undefined },
    { type: "plugins.metadata.read", input: { stateKeys: ["plugins.installedIndex"] } },
  ];
  const retainedCommand = { type: "machineState.read", input: { key: "synthetic.9999" } } as const;
  const commandTimings: { command: string; elapsedMs: number }[] = [];
  const checkedRead = async (command: OpenClawStateReadCommand, awaited = false) => {
    const result = await read(
      {},
      command,
      awaited ? { snapshotPreparation: "awaited" } : undefined,
    );
    assert(result && result.type === command.type, `missing ${command.type} result`);
    if (result.type === "machineState.read") {
      assert.equal(result.row?.value_json, '{"value":9999}');
    }
  };
  const cold = await measure(async () => {
    for (const command of commands) {
      const start = performance.now();
      await checkedRead(command, true);
      commandTimings.push({ command: command.type, elapsedMs: performance.now() - start });
    }
    await Promise.all([checkedRead(retainedCommand), checkedRead(retainedCommand)]);
  }, commands.length + 2);
  const warm = await measure(async () => {
    for (let index = 0; index < iterations; index++) {
      await checkedRead(retainedCommand, true);
    }
  }, iterations);
  console.log(
    JSON.stringify({
      workload: "synthetic early awaited reads, retained handoff, then warm reads",
      buildRoot,
      modules,
      host: hostname(),
      node: process.version,
      allocationSampling: values.allocations,
      cold: { ...cold, commandTimings },
      warm,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  await close();
  await closeNative();
  rmSync(scratch, { recursive: true, force: true });
}
