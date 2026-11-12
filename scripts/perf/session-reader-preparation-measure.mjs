// Measure warm ordinary reads over 5,000 synthetic sessions in isolated baseline/candidate processes.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-reader-preparation-measure.mjs
//   --checkout <checkout> --root <new-synthetic-directory> --iterations 1000 --serve
// Each server accepts one JSON command per line: {"warmup":true}, {"mode":"timing"},
// {"mode":"allocation"}, or {"stop":true}. Alternate A1/B/A2 for five rounds per mode.
// --alias exercises a symlink locator. Startup is excluded; no real state is read or copied.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    alias: { type: "boolean" },
    serve: { type: "boolean" },
    checkout: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "1000" },
  },
});
assert(values.root && global.gc, "Use --root and --expose-gc");
assert(["timing", "allocation"].includes(values.mode));
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = path.resolve(values.root);
fs.mkdirSync(root);
process.env.OPENCLAW_STATE_DIR = root;
assert(values.checkout);
const checkout = path.resolve(values.checkout);
const load = (relative) => import(pathToFileURL(path.join(checkout, relative)).href);
const source = [
  "src/config/sessions/session-store-target-runtime.ts",
  "src/config/sessions/session-store-target-inventory.ts",
]
  .map((name) => fs.readFileSync(path.join(checkout, name), "utf8"))
  .join("\n");
const { applyLoggingConfig, flushLogger } = await load("src/logging/logger.ts");
applyLoggingConfig({
  level: "error",
  file: path.join(root, "measure.log"),
  consoleLevel: "silent",
});
const {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} = await load("src/state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabaseAsync } = await load("src/state/openclaw-state-db.ts");
const { writeSessionEntry } = await load(
  "src/config/sessions/session-accessor.sqlite-entry-store.ts",
);
const { withSessionEntriesFromStoreInWorker } = await load(
  "src/config/sessions/session-entry-read-runtime.ts",
);
const options = { agentId: "synthetic", env: { OPENCLAW_STATE_DIR: root } };
const seeded = openOpenClawAgentDatabase(options);
runOpenClawAgentWriteTransaction((database) => {
  for (let i = 0; i < 5000; i++) {
    writeSessionEntry(database, `agent:synthetic:session-${i}`, {
      sessionId: `synthetic-${i}`,
      updatedAt: i + 1,
    });
  }
}, options);
await closeOpenClawAgentDatabasesAsync();
const readPath = values.alias ? path.join(root, "selected.sqlite") : seeded.path;
if (values.alias) {
  fs.symlinkSync(seeded.path, readPath);
}
let active = false;
let syncCalls = 0;
let realpathCalls = 0;
const realpath = fs.realpathSync.native;
fs.realpathSync.native = function (...args) {
  if (active && [seeded.path, readPath].includes(String(args[0]))) {
    realpathCalls++;
  }
  return Reflect.apply(realpath, this, args);
};
const stat = fs.statSync;
fs.statSync = function (...args) {
  if (active && [seeded.path, readPath].includes(String(args[0]))) {
    syncCalls++;
  }
  return Reflect.apply(stat, this, args);
};
syncBuiltinESMExports();
const cycle = () =>
  withSessionEntriesFromStoreInWorker(
    {
      ...options,
      storePath: readPath,
      sessionKeys: ["agent:synthetic:session-42"],
      projection: "list",
    },
    async (read) => assert.equal(read.result.entries[0]?.entry.sessionId, "synthetic-42"),
  );
const inspector = new Session();
async function measure(mode) {
  assert(["timing", "allocation"].includes(mode));
  syncCalls = 0;
  realpathCalls = 0;
  global.gc();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const started = performance.now();
  active = true;
  for (let i = 0; i < iterations; i++) {
    await cycle();
  }
  active = false;
  const elapsedMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(thread);
  const processCpu = process.cpuUsage(cpu);
  let bytes;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node) =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    bytes = sum(profile.head) / iterations;
    inspector.disconnect();
  }
  return {
    mode,
    alias: values.alias ?? false,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    iterations,
    sessions: 5000,
    syncCalls,
    realpathCalls,
    elapsedMs: elapsedMs / iterations,
    threadUs: (threadCpu.user + threadCpu.system) / iterations,
    processUs: (processCpu.user + processCpu.system) / iterations,
    bytes,
    load: loadavg(),
  };
}
try {
  for (let i = 0; i < 50; i++) {
    await cycle();
  }
  if (values.serve) {
    console.log(JSON.stringify({ ready: true }));
    const commands = createInterface({ input: process.stdin });
    for await (const line of commands) {
      const command = JSON.parse(line);
      if (command.stop) {
        break;
      }
      if (command.warmup) {
        for (let i = 0; i < 50; i++) {
          await cycle();
        }
        console.log(JSON.stringify({ ready: true }));
      } else {
        console.log(JSON.stringify(await measure(command.mode)));
      }
    }
    commands.close();
  } else {
    console.log(JSON.stringify(await measure(values.mode)));
  }
} finally {
  active = false;
  fs.statSync = stat;
  fs.realpathSync.native = realpath;
  syncBuiltinESMExports();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await flushLogger();
  fs.rmSync(root, { recursive: true, force: true });
}
