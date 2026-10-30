/**
 * Real config-health reads against an existing synthetic Team-shaped state directory.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/config-health-read-measure.ts
 *   --state-dir .local/team-fixture/state --config-path .local/team-fixture/openclaw.json
 *   --iterations 3000 --mode timing --output .local/health-timing.json
 * Repeat in a fresh process with --mode allocation (4 KiB sampling including collected
 * objects). --owner <saved-io.health-state.ts> loads baseline source at its canonical URL.
 * --read-owner <saved-openclaw-state-read-operation.ts> replaces the read dispatcher;
 * --live-owner holds the synthetic fixture open in a separate Gateway-owner process.
 * Alternate base/candidate order. The first read measures cold owner work after imports;
 * subsequent reads measure the warm receipt cache. No database or fixture is created.
 * Cold wall time includes reader-worker startup; compare built Gateway boots separately.
 * Compare snapshotFingerprint across arms. CPU and allocation describe the main thread;
 * worker CPU/allocation and native buffers are not included. Never time the traced pass.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "config-path": { type: "string" },
    owner: { type: "string" },
    "read-owner": { type: "string" },
    "live-owner": { type: "boolean", default: false },
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
  },
});
assert(
  values["state-dir"] && values["config-path"],
  "Provide synthetic --state-dir and --config-path",
);
assert(values.mode === "timing" || values.mode === "allocation", "Invalid --mode");
assert(globalThis.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 3000,
  min: 1,
  label: "iterations",
});
const stateDir = path.resolve(values["state-dir"]);
const configPath = path.resolve(values["config-path"]);
const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
const databaseBefore = statSync(databasePath);
assert(statSync(configPath).isFile(), "Config fixture is not a file");
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = configPath;
const ownerUrl = new URL("../../src/config/io.health-state.ts", import.meta.url).href;
const readOwnerUrl = new URL("../../src/state/openclaw-state-read-operation.ts", import.meta.url)
  .href;
const replacements = new Map(
  [
    [ownerUrl, values.owner],
    [readOwnerUrl, values["read-owner"]],
  ]
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([url, file]) => [url, pathToFileURL(path.resolve(file)).href]),
);
const replaced = new Set<string>();
if (replacements.size) {
  registerHooks({
    load(url, context, nextLoad) {
      const replacement = replacements.get(url);
      if (!replacement) {
        return nextLoad(url, context);
      }
      replaced.add(url);
      const result = nextLoad(replacement, context);
      return { format: result.format, source: result.source, shortCircuit: true };
    },
  });
}
const { captureConfigHealthStateStore } = await import("../../src/config/io.health-state.js");
const { withArtifactPreservingStateReads } =
  await import("../../src/state/artifact-preserving-state-reads.js");
const { closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db-cache.js");
const { initializeSqliteRuntime } = await import("../../src/infra/sqlite-runtime-initialize.js");
await initializeSqliteRuntime();
assert.equal(replaced.size, replacements.size, "Requested baseline source was not loaded");
const deps = {
  env: process.env,
  homedir: () => path.dirname(stateDir),
  logger: {
    warn: (message: string) => {
      throw new Error(message);
    },
  },
};
const observe = () =>
  withArtifactPreservingStateReads(() => captureConfigHealthStateStore(deps, configPath).read());
type Snapshot = Awaited<ReturnType<typeof observe>>;
let expected: Snapshot | undefined;
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
const inspector = new Session();
let liveOwner: ChildProcess | undefined;
let ownerExit: Promise<number | null> | undefined;
async function measure(count: number) {
  globalThis.gc?.();
  await setImmediate();
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  if (values.mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < count; index++) {
    const snapshot = await observe();
    assert.notEqual(snapshot.basis, null, "Health read failed instead of returning database rows");
    if (expected) {
      assert.equal(snapshot, expected, "Warm receipt cache changed the snapshot identity");
    } else {
      expected = snapshot;
    }
  }
  const elapsed = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const allocatedBytes =
    values.mode === "allocation"
      ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
  return {
    iterations: count,
    cpuMs: values.mode === "timing" ? (used.user + used.system) / 1000 : undefined,
    wallMs: values.mode === "timing" ? elapsed : undefined,
    allocatedBytes,
    memoryBefore,
    memoryAfter,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  };
}
try {
  if (values["live-owner"]) {
    const source = `
      import assert from "node:assert/strict";
      import { DatabaseSync } from "node:sqlite";
      import { acquireGatewayStateOwner } from ${JSON.stringify(new URL("../../src/infra/gateway-state-owner.ts", import.meta.url).href)};
      import { defaultPayload } from ${JSON.stringify(new URL("../../src/infra/gateway-state-owner-record.ts", import.meta.url).href)};
      const databasePath = ${JSON.stringify(databasePath)};
      const owner = acquireGatewayStateOwner({ databasePath, payload: { ...defaultPayload(databasePath), role: "gateway" } });
      let db;
      const close = () => { try { db?.close(); } finally { owner.release(); } };
      process.once("disconnect", () => { close(); process.exit(0); });
      process.once("SIGTERM", () => { close(); process.exit(0); });
      try {
        db = new DatabaseSync(databasePath);
        assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
        db.prepare("SELECT count(*) FROM config_health_entries").get();
        process.send("ready");
      } catch (error) { close(); throw error; }
    `;
    const child = spawn(
      process.execPath,
      [
        "--import",
        new URL("../tsx.mjs", import.meta.url).href,
        "--input-type=module",
        "-e",
        source,
      ],
      { stdio: ["ignore", "inherit", "inherit", "ipc"] },
    );
    liveOwner = child;
    ownerExit = new Promise((resolve, reject) => {
      // Inherited stdio needs no drain; IPC disconnect may omit Node's close event.
      child.once("exit", resolve);
      child.once("error", reject);
    });
    void ownerExit.catch(() => {});
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Synthetic owner exited before readiness: ${code}`)),
      );
      child.once("message", (message) =>
        message === "ready" ? resolve() : reject(new Error("Unexpected owner readiness")),
      );
    });
  }
  if (values.mode === "allocation") {
    inspector.connect();
  }
  const cold = await measure(1);
  const warm = await measure(iterations);
  assert(expected);
  const result = {
    mode: values.mode,
    owner: values.owner ?? ownerUrl,
    readOwner: values["read-owner"] ?? readOwnerUrl,
    liveOwner: values["live-owner"],
    node: process.version,
    databaseBytes: databaseBefore.size,
    healthRows: Object.keys(expected.basis ?? {}).length,
    snapshotFingerprint: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
    cold,
    warm,
  };
  const output = JSON.stringify(result, null, 2);
  if (values.output) {
    writeFileSync(values.output, `${output}\n`);
  }
  console.log(output);
} finally {
  inspector.disconnect();
  try {
    await closeOpenClawStateDatabaseAsync();
  } finally {
    if (liveOwner) {
      if (liveOwner.connected) {
        liveOwner.disconnect();
      }
      assert.equal(await ownerExit, 0, "Synthetic owner did not exit cleanly");
    }
  }
  const databaseAfter = statSync(databasePath);
  assert.equal(databaseAfter.size, databaseBefore.size, "Benchmark changed fixture size");
  assert.equal(databaseAfter.mtimeMs, databaseBefore.mtimeMs, "Benchmark changed fixture mtime");
}
