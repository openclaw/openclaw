// Run on the approved benchmark host with --expose-gc --import ./scripts/tsx.mjs.
// --committed-writes measures real presence commits followed by catalog reads; otherwise each
// operation forces a native invalidation. Example: --committed-writes --operations 4000 --warmup 100
// --devices 64 --mode timing --state-dir <fresh-dir> --output <result.json>. Repeat with allocation.
// To compare owners in one checkout, pass --publication-source and --reader-source with baseline
// files adjacent to their originals so relative imports resolve. CPU covers the whole operation;
// readLatency isolates the post-commit catalog read, and allocation samples the main isolate only.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { PairedDevice } from "../../src/infra/device-pairing.types.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    "state-dir": { type: "string" },
    operations: { type: "string", default: "4000" },
    warmup: { type: "string", default: "100" },
    devices: { type: "string", default: "64" },
    "publications-per-minute": { type: "string", default: "200" },
    "start-at": { type: "string", default: "0" },
    "start-file": { type: "string" },
    "ready-file": { type: "string" },
    "warm-start-file": { type: "string" },
    "warm-ready-file": { type: "string" },
    "publication-source": { type: "string" },
    "reader-source": { type: "string" },
    "committed-writes": { type: "boolean", default: false },
    "gc-log": { type: "string" },
    output: { type: "string" },
  },
});
const integer = (name: Exclude<keyof typeof values, "committed-writes">, min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
assert(global.gc, "Run with --expose-gc");
assert(values["state-dir"] && values.output, "Supply a fresh --state-dir and --output");
assert(["timing", "allocation", "promotion"].includes(values.mode!));
const traced = [...process.execArgv, process.env.NODE_OPTIONS ?? ""].some((arg) =>
  /--trace[-_]gc/.test(arg),
);
assert(values.mode === "promotion" || !traced, "Timing and allocation must be untraced");
assert(
  values.mode !== "promotion" || (traced && values["gc-log"]),
  "Promotion requires --trace-gc-nvp and --gc-log",
);
const stateDir = path.resolve(values["state-dir"]);
mkdirSync(stateDir, { mode: 0o700 });
process.env.OPENCLAW_STATE_DIR = stateDir;
const operations = integer("operations", 1);
const warmup = integer("warmup", 0);
const deviceCount = integer("devices", 1);
const publicationsPerMinute = integer("publications-per-minute", 1);
const profilePath = path.resolve(`${values.output}.heapprofile`);
const marker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
if (values.mode === "promotion") {
  marker("identify-start");
  global.gc();
  marker("identify-stop");
}

const publicationUrl = new URL("../../src/infra/device-pairing-publication.ts", import.meta.url);
const publicationSource = values["publication-source"]
  ? path.resolve(values["publication-source"])
  : fileURLToPath(publicationUrl);
const readerUrl = new URL("../../src/infra/device-pairing-store-readonly.ts", import.meta.url);
const readerSource = values["reader-source"]
  ? path.resolve(values["reader-source"])
  : fileURLToPath(readerUrl);
let publicationSubstitutions = 0;
let readerSubstitutions = 0;
const hooks =
  values["publication-source"] || values["reader-source"]
    ? registerHooks({
        resolve(specifier, context, nextResolve) {
          if (
            context.parentURL &&
            specifier.startsWith(".") &&
            values["publication-source"] &&
            new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL).href ===
              publicationUrl.href
          ) {
            publicationSubstitutions++;
            return nextResolve(pathToFileURL(publicationSource).href, context);
          }
          if (
            context.parentURL &&
            specifier.startsWith(".") &&
            values["reader-source"] &&
            new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL).href === readerUrl.href
          ) {
            readerSubstitutions++;
            return nextResolve(pathToFileURL(readerSource).href, context);
          }
          return nextResolve(specifier, context);
        },
      })
    : undefined;

const [database, store, publication, reads, pairing] = await Promise.all([
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/infra/device-pairing-store.js"),
  import("../../src/infra/device-pairing-publication.js"),
  import("../../src/infra/device-pairing-store-readonly.js"),
  import("../../src/infra/device-pairing.js"),
]);
const devices: PairedDevice[] = Array.from({ length: deviceCount }, (_, index) => ({
  deviceId: `synthetic-node-${index}`,
  publicKey: `synthetic-public-key-${index}`,
  displayName: `Synthetic node ${index}`,
  platform: "linux",
  roles: ["node"],
  tokens: {
    node: { token: `synthetic-token-${index}`, role: "node", scopes: [], createdAtMs: 1 },
  },
  nodeSurface: {
    caps: ["canvas"],
    commands: ["system.run"],
    permissions: { screenRecording: true },
    bins: ["git", "node"],
    createdAtMs: 1,
    approvedAtMs: index + 1,
  },
  createdAtMs: 1,
  approvedAtMs: index + 1,
}));
const db = database.openOpenClawStateDatabase();
store.persistDevicePairingStoreState(
  { pendingById: {}, pairedByDeviceId: Object.fromEntries(devices.map((d) => [d.deviceId, d])) },
  stateDir,
  "both",
);
const generations = values["committed-writes"]
  ? devices.map((device) => {
      const generation = pairing.resolveNodePairingGeneration(device);
      assert(generation, "Synthetic device must have an approved node generation");
      return generation;
    })
  : undefined;
let committedWrites = 0;
const lastSeenByDevice: number[] = [];
const inspector = new Session();
const loop = monitorEventLoopDelay({ resolution: 1 });
const collections: { kind: number; ms: number; at: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = (entry as typeof entry & { detail: { kind: number } }).detail;
    collections.push({ kind: detail.kind, ms: entry.duration, at: entry.startTime });
  }
});
const distribution = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    maxMs: sorted.at(-1) ?? 0,
    p50: { samples: sorted.length, ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null },
    p95: { samples: sorted.length, ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null },
    p99: { samples: sorted.length, ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null },
  };
};
async function run(count: number, latencies?: number[], readLatencies?: number[]) {
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    if (generations) {
      const deviceIndex = committedWrites % deviceCount;
      const lastSeenAtMs = ++committedWrites + 1;
      assert(
        await pairing.updatePairedDevicePresence(
          devices[deviceIndex]!.deviceId,
          { lastSeenAtMs, lastSeenReason: "node-event" },
          generations[deviceIndex]!,
          stateDir,
        ),
        "Presence update must commit under the original node generation",
      );
      lastSeenByDevice[deviceIndex] = lastSeenAtMs;
    } else {
      // Native committed writes use this invalidation; force the miss without disk churn.
      publication.invalidateDevicePairingNodeSnapshot(db.path);
    }
    const readStarted = performance.now();
    const snapshot = await reads.readDevicePairingNodeSnapshot(stateDir);
    readLatencies?.push(performance.now() - readStarted);
    latencies?.push(performance.now() - started);
    assert.equal(snapshot.paired.length, deviceCount);
    assert.equal(snapshot.bindings.size, deviceCount);
    await delay(1);
  }
}
async function waitForStart(warming = false) {
  const readyFile = values[warming ? "warm-ready-file" : "ready-file"];
  const startFile = values[warming ? "warm-start-file" : "start-file"];
  const ready = JSON.stringify({
    pid: process.pid,
    mode: values.mode,
    warming,
    readyAt: Date.now(),
  });
  if (readyFile) {
    await fs.writeFile(readyFile, ready);
  }
  writeSync(1, `PAIRING_READY ${ready}\n`);
  let startAt = warming ? 0 : integer("start-at", 0);
  if (startFile) {
    const deadline = Date.now() + 600_000;
    for (;;) {
      try {
        startAt = Number(await fs.readFile(startFile, "utf8"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      assert(Date.now() < deadline, "Shared start barrier timed out");
      await delay(50);
    }
    assert(
      Number.isSafeInteger(startAt) && startAt > 0,
      "Start file must contain an epoch in milliseconds",
    );
  }
  if (startAt) {
    assert(startAt > Date.now(), "Preparation missed the shared start deadline");
    await delay(startAt - Date.now());
  }
}
try {
  const golden = devices.toReversed();
  const first = await reads.readDevicePairingNodeSnapshot(stateDir);
  assert(
    !values["publication-source"] || publicationSubstitutions > 0,
    "Publication override must load",
  );
  assert(!values["reader-source"] || readerSubstitutions > 0, "Reader override must load");
  assert.deepEqual(first.paired, golden);
  assert(Object.isFrozen(first.paired[0]!.tokens!.node!.scopes));
  assert.equal(await reads.readDevicePairingNodeSnapshot(stateDir), first);
  if (values["warm-start-file"] || values["warm-ready-file"]) {
    await waitForStart(true);
  }
  await run(warmup);
  global.gc();
  await nextTurn();
  let allocation: object | undefined;
  let timing: object | undefined;
  if (values.mode === "allocation") {
    inspector.connect();
    await waitForStart();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const startedAt = Date.now();
    const started = performance.now();
    await run(operations);
    const elapsedMs = performance.now() - started;
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    let totalBytes = 0;
    let inspectionBytes = 0;
    const visit = (node: HeapProfiler.SamplingHeapProfileNode, inspecting = false) => {
      const inside = inspecting || node.callFrame.functionName === "inspectPlainData";
      totalBytes += node.selfSize;
      if (inside) {
        inspectionBytes += node.selfSize;
      }
      node.children.forEach((child) => visit(child, inside));
    };
    visit(profile.head);
    writeFileSync(profilePath, JSON.stringify(profile));
    allocation = {
      startedAt,
      elapsedMs,
      totalBytes,
      bytesPerPublication: totalBytes / operations,
      inspectionBytes,
      inspectionBytesPerPublication: inspectionBytes / operations,
      modeledPublicationsPerMinute: publicationsPerMinute,
      modeledBytesPerMinute: (totalBytes / operations) * publicationsPerMinute,
      samplingInterval: 32_768,
      includesCollectedObjects: true,
      profilePath,
    };
  } else {
    const latencies: number[] = [];
    const readLatencies: number[] = [];
    observer.observe({ entryTypes: ["gc"] });
    loop.enable();
    await waitForStart();
    loop.reset();
    const startedAt = Date.now();
    const cpu = process.threadCpuUsage();
    const processCpu = process.cpuUsage();
    marker("diagnostics-start");
    const started = performance.now();
    await run(operations, latencies, readLatencies);
    const ended = performance.now();
    const usedCpu = process.threadCpuUsage(cpu);
    const usedProcessCpu = process.cpuUsage(processCpu);
    marker("diagnostics-stop");
    loop.disable();
    await nextTurn();
    for (const entry of observer.takeRecords()) {
      const detail = (entry as typeof entry & { detail: { kind: number } }).detail;
      collections.push({ kind: detail.kind, ms: entry.duration, at: entry.startTime });
    }
    observer.disconnect();
    const gc = (kind?: number) =>
      distribution(
        collections
          .filter((e) => e.at >= started && e.at < ended && (kind === undefined || e.kind === kind))
          .map((e) => e.ms),
      );
    const promotion =
      values.mode === "promotion"
        ? readGatewayGcTrace(path.resolve(values["gc-log"]!), profilePath, "diagnostics")
        : undefined;
    const elapsedMs = ended - started;
    const total = gc();
    timing = {
      traced: values.mode === "promotion",
      startedAt,
      elapsedMs,
      cpu: {
        totalMs: (usedCpu.user + usedCpu.system) / 1000,
        msPerPublication: (usedCpu.user + usedCpu.system) / 1000 / operations,
      },
      processCpu: {
        totalMs: (usedProcessCpu.user + usedProcessCpu.system) / 1000,
        msPerPublication: (usedProcessCpu.user + usedProcessCpu.system) / 1000 / operations,
      },
      latency: distribution(latencies),
      readLatency: distribution(readLatencies),
      gc: {
        total,
        msPerPublication: total.totalMs / operations,
        msPerMinute: (total.totalMs * 60000) / elapsedMs,
        minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
        major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
        incremental: gc(constants.NODE_PERFORMANCE_GC_INCREMENTAL),
        weakCallbacks: gc(constants.NODE_PERFORMANCE_GC_WEAKCB),
      },
      promotion: promotion
        ? { ...promotion, bytesPerPublication: promotion.promotedBytes / operations }
        : null,
      eventLoop: {
        samples: loop.count,
        maxMs: loop.max / 1e6,
        p95: { samples: loop.count, ms: loop.percentile(95) / 1e6 },
        p99: { samples: loop.count, ms: loop.percentile(99) / 1e6 },
      },
    };
  }
  const last = await reads.readDevicePairingNodeSnapshot(stateDir);
  const finalGolden = devices
    .map((device, index) =>
      lastSeenByDevice[index] === undefined
        ? device
        : Object.assign({}, device, {
            lastSeenAtMs: lastSeenByDevice[index],
            lastSeenReason: "node-event",
          }),
    )
    .toReversed();
  assert.deepEqual(last.paired, finalGolden);
  assert.deepEqual(first.paired, golden);
  assert.notEqual(last, first);
  assert(Object.isFrozen(last.paired[0]!.tokens!.node!.scopes));
  assert.equal(await reads.readDevicePairingNodeSnapshot(stateDir), last);
  const result = {
    scope: values["committed-writes"]
      ? "real presence commits and subsequent catalog reads; whole-operation CPU and main-isolate allocation, no Gateway RPC or model"
      : "real pairing reader, SQLite worker and shared publication; forced publication misses, no Gateway RPC or model",
    node: process.version,
    mode: values.mode,
    sourceHash: hash("sha256", readFileSync(publicationSource)),
    readerSourceHash: hash("sha256", readFileSync(readerSource)),
    committedWrites,
    operations,
    warmup,
    deviceCount,
    fixtureHash: hash("sha256", JSON.stringify(golden)),
    allocation,
    timing,
  };
  writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector.disconnect();
  observer.disconnect();
  loop.disable();
  await database.closeOpenClawStateDatabaseAsync();
  hooks?.deregister();
}
