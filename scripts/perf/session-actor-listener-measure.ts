// Run on the approved benchmark host with --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, serialize } from "node:v8";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "replica-owner": { type: "string" },
    "start-at": { type: "string", default: "0" },
    iterations: { type: "string", default: "100000" },
    allocations: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir must name a private benchmark directory");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1000,
  fallback: 100000,
});
const startAt = Number(values["start-at"]);
assert(Number.isSafeInteger(startAt) && startAt >= 0, "--start-at must be epoch milliseconds");
await mkdir(values["state-dir"], { recursive: true });
const stateDir = await mkdtemp(path.join(path.resolve(values["state-dir"]), "listener-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
const ownerUrl = values["replica-owner"]
  ? pathToFileURL(path.resolve(values["replica-owner"]))
  : new URL("../../src/config/sessions/session-actor-replica.ts", import.meta.url);
const [owner, publication, changes, sqlite, admission, immutable] = await Promise.all([
  import(ownerUrl.href) as Promise<
    typeof import("../../src/config/sessions/session-actor-replica.js")
  >,
  import("../../src/config/sessions/session-accessor.sqlite-entry-cache-publication.js"),
  import("../../src/sessions/session-row-changes.js"),
  import("../../src/infra/node-sqlite.js"),
  import("../../src/infra/sqlite-database-admission.js"),
  import("../../src/shared/immutable-data.js"),
]);
const sourceHash = hash("sha256", await readFile(ownerUrl), "hex");
const databasePath = path.join(stateDir, "admission.sqlite");
const database = sqlite.openNodeSqliteDatabase(databasePath);
const identity = admission.getSqliteDatabaseAdmissionIdentityForPath(databasePath);
assert(identity && identity.key.startsWith("file:"), "Replica requires admitted physical identity");
const source = {
  identity: identity.key.slice("file:".length),
  birthtime: identity.birthtime,
  incarnation: "synthetic-incarnation",
  filename: databasePath,
  canonicalPath: databasePath,
  writeToken: admission.readSqliteDatabaseWriteTokenForPath(databasePath),
};
const fixtures = Array.from({ length: 32 }, (_, index) => {
  const sessionKey = `agent:main:synthetic-listener-${index}`;
  const entry: InternalSessionEntry = immutable.freezeTrustedJsonSnapshot({
    sessionId: `synthetic-session-${index}`,
    updatedAt: 1000 + index,
    label: `Synthetic finished subagent ${index}`,
    skillsSnapshot: { prompt: "Synthetic saved instructions. ".repeat(1024), skills: [] },
    pluginExtensions: {
      synthetic: {
        results: Array.from({ length: 16 }, (_result, item) => ({
          id: `result-${item}`,
          text: `Synthetic result ${index}/${item}. `.repeat(16),
        })),
      },
    },
  });
  const change = { sessionKey, storePath: databasePath, facts: { kind: "unchanged" as const } };
  publication.bindPreparedSessionEntryPublication(change, {
    kind: "metadata",
    sharingChange: "unchanged",
    prepared: {
      source,
      entries: new Map([[sessionKey, entry]]),
      fullEntries: new Map([[sessionKey, entry]]),
    },
  });
  const target = {
    sessionKey,
    database: {
      kind: "file" as const,
      physicalIdentity: source.identity,
      birthtime: identity.birthtime,
      nativeLocation: databasePath,
    },
  };
  owner.retainSessionActorEntryFacts(
    target.database,
    [{ sessionKey, facts: { entry, snapshots: "full" } }],
    source.incarnation,
  );
  return { change, target, entry };
});
const emit = (index: number) =>
  changes.sessionChanges.emit(fixtures[index % fixtures.length]!.change);
const quantiles = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
    maxMs: sorted.at(-1),
  };
};
const inspector = new Session();
inspector.connect();
try {
  let cloneCount = 0;
  let clonedBytes = 0;
  let entryCloneCount = 0;
  let entryClonedBytes = 0;
  const entryObjects = new Set<unknown>(fixtures.map(({ entry }) => entry));
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = (value, options) => {
    cloneCount++;
    const bytes = serialize(value).byteLength;
    clonedBytes += bytes;
    if (entryObjects.has(value)) {
      entryCloneCount++;
      entryClonedBytes += bytes;
    }
    return clone(value, options);
  };
  try {
    fixtures.forEach((_, index) => emit(index));
  } finally {
    globalThis.structuredClone = clone;
  }
  const verify = () => {
    for (const fixture of fixtures) {
      const retained = owner.readSessionActorEntryFacts(fixture.target)?.entry;
      assert.deepEqual(retained, fixture.entry);
      assert(Object.isFrozen(retained));
      assert(Object.isFrozen(retained?.pluginExtensions?.synthetic));
      assert(Object.isFrozen(retained?.skillsSnapshot));
      assert.throws(() => {
        retained!.skillsSnapshot!.prompt = "Mutation must fail";
      }, TypeError);
    }
  };
  verify();
  for (let index = 0; index < 2000; index++) {
    emit(index);
  }
  await inspector.post("HeapProfiler.collectGarbage");
  if (startAt) {
    assert(Date.now() < startAt, "Missed synchronized warm start");
    await setTimeout(startAt - Date.now());
  }
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const latency: number[] = [];
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  const gc = new GCProfiler();
  gc.start();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    emit(index);
    latency.push(performance.now() - before);
    if (index % 32 === 31) {
      await setImmediate();
    }
  }
  const elapsedMs = performance.now() - started;
  const cpuUsed = process.cpuUsage(cpu);
  const statistics = gc.stop()?.statistics ?? [];
  loop.disable();
  let allocationBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const total = (node: typeof profile.head): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
    allocationBytes = total(profile.head);
  }
  verify();
  const result = {
    sourceHash,
    node: process.version,
    iterations,
    startAt,
    elapsedMs,
    cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    diagnostic: {
      installs: fixtures.length,
      cloneCount,
      clonedBytes,
      entryCloneCount,
      entryClonedBytes,
    },
    sharedEntries: fixtures.filter(
      ({ target, entry }) => owner.readSessionActorEntryFacts(target)?.entry === entry,
    ).length,
    allocationBytes,
    allocationBytesPerInstall:
      allocationBytes === undefined ? undefined : allocationBytes / iterations,
    latency: quantiles(latency),
    loop: {
      samples: loop.count,
      p95Ms: loop.percentile(95) / 1e6,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
    },
    gc: ["Scavenge", "MinorMarkSweep", "MarkSweepCompact", "IncrementalMarking"].map((kind) => {
      const durations = statistics
        .filter((sample) => sample.gcType === kind)
        .map((sample) => sample.cost / 1000);
      return Object.assign(
        { kind, totalMs: durations.reduce((sum, value) => sum + value, 0) },
        quantiles(durations),
      );
    }),
    scope:
      "Prepared immutable metadata receipts through real notify/install; excludes producer decoding, Gateway and RPC",
  };
  if (values.output) {
    await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  inspector.disconnect();
  database.close();
  await rm(stateDir, { recursive: true, force: true });
}
