/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-delivery-generation-measure.ts
 *   --scratch /absolute/synthetic/scratch [--owner-dir /absolute/baseline-overlay]
 *   [--mode cpu|allocation] [--iterations 10000] [--preparations 50] [--sessions 10000]
 * Run fresh processes as A/A controls and at least five interleaved A/B pairs.
 * The sparse overlay contains changed owner modules at their original paths and a
 * root package.json with {"type":"module"}.
 * This measures real database owners, not a Gateway turn: assertion counts per turn
 * depend on its tools and deliveries. Filesystem counts and allocation are main-isolate
 * only; process CPU includes workers. Worker admission is included in preparation time.
 * Database bytes are reported, not inflated to mimic a 35 GiB store: inode probes do
 * not read database pages or traverse workspaces. No production data is used.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    scratch: { type: "string" },
    "owner-dir": { type: "string" },
    mode: { type: "string", default: "cpu" },
    iterations: { type: "string", default: "10000" },
    preparations: { type: "string", default: "50" },
    sessions: { type: "string", default: "10000" },
    "profile-dir": { type: "string" },
  },
});
assert(values.scratch && path.isAbsolute(values.scratch), "--scratch must be absolute");
assert(values.mode === "cpu" || values.mode === "allocation");
assert(globalThis.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
const preparations = Number(values.preparations);
const sessions = Number(values.sessions);
assert([iterations, preparations, sessions].every((n) => Number.isSafeInteger(n) && n > 0));
fs.mkdirSync(values.scratch, { recursive: true });
process.env.TMPDIR = values.scratch;
if (values["profile-dir"]) {
  fs.mkdirSync(values["profile-dir"], { recursive: true });
}
if (values["owner-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["owner-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const [{ withOpenClawTestState }, agent, entries, owner] = await Promise.all([
  import("../../src/test-utils/openclaw-test-state.ts"),
  import("../../src/state/openclaw-agent-db.ts"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts"),
  import("../../src/config/sessions/session-delivery-generation.ts"),
]);
let measuring = false;
const calls = { statSync: 0, realpathSync: 0, realpathNative: 0 };
const originals = {
  statSync: fs.statSync,
  realpathSync: fs.realpathSync,
  realpathNative: fs.realpathSync.native,
};
function counted<T extends (...args: never[]) => unknown>(key: keyof typeof calls, operation: T) {
  return function (this: unknown, ...args: Parameters<T>) {
    if (measuring) {
      calls[key]++;
    }
    return Reflect.apply(operation, this, args);
  };
}
Object.defineProperty(fs, "statSync", { value: counted("statSync", originals.statSync) });
Object.defineProperty(fs, "realpathSync", {
  value: Object.assign(counted("realpathSync", originals.realpathSync), {
    native: counted("realpathNative", originals.realpathNative),
  }),
});
syncBuiltinESMExports();
const inspector = new Session();
inspector.connect();
try {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = agent.openOpenClawAgentDatabase({ agentId: "main", env });
    const entry = (index: number) => ({
      sessionId: `synthetic-generation-${index}`,
      lifecycleRevision: `synthetic-lifecycle-${index}`,
      updatedAt: 1,
      permissionMode: "full" as const,
      toolOverrides: { webSearch: true },
    });
    const key = (index: number) => `agent:main:synthetic-generation-${index}`;
    agent.runOpenClawAgentWriteTransaction(
      (current) => {
        for (let index = 0; index < sessions; index++) {
          entries.writeSessionEntry(current, key(index), entry(index));
        }
      },
      { agentId: "main", path: database.path, env },
    );
    const facts = {
      agentId: "main",
      storePath: database.path,
      sessionKey: key(0),
      ...entry(0),
      env,
    };
    const fixture = {
      sessions,
      databaseBytes: fs.statSync(database.path).size,
      walBytes: fs.statSync(`${database.path}-wal`, { throwIfNoEntry: false })?.size ?? 0,
      workspaceFiles: 0,
      platform: process.platform,
      node: process.version,
    };
    async function measure(name: string, count: number, run: (n: number) => Promise<void>) {
      await run(Math.min(count, name === "delivery-preparation" ? 5 : 2000));
      globalThis.gc!();
      if (values.mode === "allocation") {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 1024,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      if (values["profile-dir"]) {
        await inspector.post("Profiler.enable");
        await inspector.post("Profiler.start");
      }
      calls.statSync = calls.realpathSync = calls.realpathNative = 0;
      const load = loadavg();
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      measuring = true;
      try {
        await run(count);
      } finally {
        measuring = false;
      }
      const wallMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      let sampledBytes: number | undefined;
      if (values.mode === "allocation") {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
      }
      if (values["profile-dir"]) {
        const { profile } = await inspector.post("Profiler.stop");
        fs.writeFileSync(
          path.join(values["profile-dir"], `${name}.cpuprofile`),
          JSON.stringify(profile),
        );
      }
      console.log(
        JSON.stringify({
          scenario: name,
          mode: values.mode,
          ...fixture,
          count,
          load,
          calls: { ...calls },
          statsPerOperation: calls.statSync / count,
          wallUsPerOperation: (wallMs * 1000) / count,
          cpuUsPerOperation: (cpu.user + cpu.system) / count,
          sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / count,
        }),
      );
    }
    await measure("delivery-preparation", preparations, async (count) => {
      for (let index = 0; index < count; index++) {
        const delivery = await owner.prepareSessionDeliveryGeneration(facts);
        delivery.assertCurrent();
        delivery.release();
      }
    });
    const generation = await owner.prepareSessionGenerationFacts(facts);
    try {
      await measure("generation-assertion", iterations, async (count) => {
        for (let index = 0; index < count; index++) {
          generation.assertCurrent();
        }
      });
      const source = await generation.assertCurrent.prepareSessionSource!();
      try {
        await measure("prepared-source-assertion", iterations, async (count) => {
          for (let index = 0; index < count; index++) {
            source.assertCurrent();
          }
        });
      } finally {
        await source.release?.();
      }
    } finally {
      generation.release();
    }
  });
} finally {
  inspector.disconnect();
  fs.statSync = originals.statSync;
  fs.realpathSync = originals.realpathSync;
  syncBuiltinESMExports();
}
