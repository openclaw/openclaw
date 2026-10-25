// Owner-level probe; pair with the sessions.cleanup Gateway workload in README.md.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { WorkerSessionPlacementRecord } from "../../src/gateway/worker-environments/placement-record.js";
import type { PlacementAuthorityOwner } from "../../src/gateway/worker-environments/placement-turn-authority.types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    replicas: { type: "string", default: "10000" },
    protected: { type: "string", default: "64" },
    operations: { type: "string", default: "20000" },
    captures: { type: "string", default: "2" },
    warmup: { type: "string", default: "200" },
    "start-at": { type: "string", default: "0" },
    "owner-source": { type: "string" },
    "authority-state-dir": { type: "string" },
    output: { type: "string" },
  },
});
const integer = (key: keyof typeof values, min: number) =>
  parseStrictIntegerOption({ raw: values[key], label: `--${key}`, min, fallback: min });
assert(["timing", "allocation", "counts"].includes(values.mode!));
assert(
  ![...process.execArgv, process.env.NODE_OPTIONS ?? ""].some((arg) => /--trace[-_]gc/.test(arg)),
);
assert(global.gc, "Run with --expose-gc");
const replicas = integer("replicas", 0);
const protectedCount = integer("protected", 0);
assert(protectedCount <= replicas);
const operations = integer("operations", 1);
const captures = integer("captures", 1);
const source = values["owner-source"]
  ? pathToFileURL(values["owner-source"])
  : new URL(
      values["authority-state-dir"]
        ? "../../src/gateway/worker-environments/placement-turn-authority.ts"
        : "../../src/gateway/worker-environments/placement-read-authority.ts",
      import.meta.url,
    );
let captureAuthority:
  | (() => Promise<{
      placements: WorkerSessionPlacementRecord[];
      release: () => void;
    }>)
  | undefined;
let closeDatabase: (() => Promise<void>) | undefined;
let authorityOwner: PlacementAuthorityOwner | undefined;
if (values["authority-state-dir"]) {
  const root = path.resolve(values["authority-state-dir"]);
  mkdirSync(root); // Each side owns a fresh fixture.
  const syntheticEnv = {
    PATH: process.env.PATH,
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: root,
    TMPDIR: root,
    ...Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`SYNTHETIC_ENV_${index}`, "x".repeat(64)]),
    ),
  };
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, syntheticEnv);
  const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
    await import("../../src/state/openclaw-state-db.js");
  const { requireOpenClawStateDatabaseIdentity } =
    await import("../../src/state/openclaw-state-db-cache.js");
  const { placementAuthorityOwnerFor } =
    await import("../../src/gateway/worker-environments/placement-authority-owner.js");
  const { preparePlacementPreservationRead } = (await import(
    source.href
  )) as typeof import("../../src/gateway/worker-environments/placement-turn-authority.js");
  const database = openOpenClawStateDatabase();
  authorityOwner = placementAuthorityOwnerFor(
    requireOpenClawStateDatabaseIdentity({ db: database.db }),
  );
  authorityOwner.sequence = replicas;
  captureAuthority = () => preparePlacementPreservationRead(database.path, async () => baseline);
  closeDatabase = () => closeOpenClawStateDatabaseAsync();
}
const { prepareCachedPlacementPreservationRead: projectionOwner } = (await import(
  captureAuthority
    ? "../../src/gateway/worker-environments/placement-read-authority.js"
    : source.href
)) as typeof import("../../src/gateway/worker-environments/placement-read-authority.js");
const owner: PlacementAuthorityOwner = authorityOwner ?? {
  identity: { key: "synthetic-placement-owner", canonicalPath: "synthetic-placement-owner" },
  active: true,
  localClaimSessions: new Set(),
  localAdmissionReservations: new Map(),
  localMutationSettlements: new Map(),
  changeListeners: new Set(),
  claims: new Map(),
  placements: new Map(),
  observations: new Map(),
  pending: new Set(),
  sequence: replicas,
  published: new Map(),
  tools: new Map(),
  workspaceResults: new Map(),
  projections: new Map(),
};
const baseline: WorkerSessionPlacementRecord[] = [];
for (let index = 0; index < replicas; index++) {
  const placement: WorkerSessionPlacementRecord = {
    sessionId: `synthetic-${index}`,
    sessionKey: `agent:main:synthetic-${index}`,
    agentId: "main",
    state: index < protectedCount ? "requested" : "local",
    executionMode: "worker-turn",
    generation: 1,
    turnClaim: null,
    environmentId: null,
    activeOwnerEpoch: null,
    workspaceBaseManifestRef: null,
    remoteWorkspaceDir: null,
    workerBundleHash: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
  };
  owner.placements.set(placement.sessionId, { placement, sequence: index + 1 });
  if (index < protectedCount) {
    baseline.push(placement);
  }
}
let environmentEnumerations = 0;
const objectKeys = Object.keys;
if (values.mode === "counts" && captureAuthority) {
  Object.keys = (object) => {
    if (object === process.env) {
      environmentEnumerations++;
    }
    return objectKeys(object);
  };
}
let entriesVisited = 0;
if (values.mode === "counts") {
  const entries = owner.placements[Symbol.iterator].bind(owner.placements);
  owner.placements[Symbol.iterator] = function* () {
    for (const entry of entries()) {
      entriesVisited++;
      yield entry;
    }
    return undefined;
  };
}
let returnedRecords = 0;
let lastSnapshot: WorkerSessionPlacementRecord[] = [];
async function run(count: number, latencies?: number[]) {
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    let released = false;
    const assertUsable = () => assert(!released && owner.active);
    const read = await (captureAuthority?.() ??
      projectionOwner(
        {
          owner,
          observation: { revoked: false, indeterminate: false },
          assertUsable,
          authority: {
            assertCurrent: assertUsable,
            release: () => {
              released = true;
            },
          },
        },
        async () => baseline,
      ));
    try {
      for (let capture = 0; capture < captures; capture++) {
        const placements = read.placements;
        assert.equal(placements.length, protectedCount);
        returnedRecords += placements.length;
        lastSnapshot = placements;
      }
    } finally {
      read.release();
    }
    latencies?.push(performance.now() - started);
    await nextTurn();
  }
}
const distribution = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    totalMs: sorted.reduce((total, value) => total + value, 0),
    maxMs: sorted.at(-1) ?? 0,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
  };
};
await run(integer("warmup", 0));
global.gc();
await nextTurn();
entriesVisited = 0;
environmentEnumerations = 0;
returnedRecords = 0;
const startAt = integer("start-at", 0);
if (startAt) {
  assert(startAt > Date.now(), "Missed shared start deadline");
  console.log(JSON.stringify({ ready: true, pid: process.pid, startAt }));
  await delay(startAt - Date.now());
}
const inspector = new Session();
const loop = monitorEventLoopDelay({ resolution: 1 });
const collections: { at: number; kind: number; ms: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = (entry as typeof entry & { detail: { kind: number } }).detail;
    collections.push({ at: entry.startTime, kind: detail.kind, ms: entry.duration });
  }
});
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
} else if (values.mode === "timing") {
  observer.observe({ entryTypes: ["gc"] });
  loop.enable();
}
const latencies: number[] = [];
const cpu = process.cpuUsage();
const started = performance.now();
await run(operations, values.mode === "timing" ? latencies : undefined);
const ended = performance.now();
const usedCpu = process.cpuUsage(cpu);
loop.disable();
await nextTurn();
observer.disconnect();
let allocationBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocationBytes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode) => {
    allocationBytes! += node.selfSize;
    node.children.forEach(visit);
  };
  visit(profile.head);
  if (values.output) {
    writeFileSync(`${values.output}.heapprofile`, JSON.stringify(profile));
  }
  inspector.disconnect();
}
assert.deepEqual(lastSnapshot, baseline);
const gc = (kind?: number) =>
  distribution(
    collections
      .filter(
        (entry) =>
          entry.at >= started && entry.at < ended && (kind === undefined || kind === entry.kind),
      )
      .map((entry) => entry.ms),
  );
const result = {
  scope: captureAuthority
    ? "real database admission and placement authority; synthetic replicas; no Gateway RPC or model"
    : "synthetic retained placement authority; no database, Gateway RPC or model",
  mode: values.mode,
  node: process.version,
  sourceHash: hash("sha256", readFileSync(fileURLToPath(source))),
  fixtureHash: hash("sha256", JSON.stringify(baseline)),
  outputHash: hash("sha256", JSON.stringify(lastSnapshot)),
  replicas,
  protectedCount,
  operations,
  captures,
  returnedRecords,
  environmentEnumerations: values.mode === "counts" ? environmentEnumerations : undefined,
  environmentEnumerationsPerMinute:
    values.mode === "counts" ? (environmentEnumerations * 60_000) / (ended - started) : undefined,
  entriesVisited: values.mode === "counts" ? entriesVisited : undefined,
  elapsedMs: ended - started,
  cpuMsPerOperation: (usedCpu.user + usedCpu.system) / 1000 / operations,
  allocationBytesPerOperation:
    allocationBytes === undefined ? undefined : allocationBytes / operations,
  latency: distribution(latencies),
  gc: {
    total: gc(),
    minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
    major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    incremental: gc(constants.NODE_PERFORMANCE_GC_INCREMENTAL),
    weakCallbacks: gc(constants.NODE_PERFORMANCE_GC_WEAKCB),
  },
  eventLoop: {
    samples: loop.count,
    p95Ms: loop.percentile(95) / 1e6,
    p99Ms: loop.percentile(99) / 1e6,
    maxMs: loop.count ? loop.max / 1e6 : null,
  },
};
if (values.output) {
  writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result));
Object.keys = objectKeys;
await closeDatabase?.();
