// Run on the approved benchmark host with Node 26 and --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler as InspectorHeapProfiler } from "node:inspector/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, serialize } from "node:v8";
import type { SessionActorHotState } from "../../src/config/sessions/session-actor-contract.js";
import type { SessionRowDatabaseFacts } from "../../src/config/sessions/session-row-facts.types.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import type { SamplingProfile } from "../../src/logging/diagnostic-heap-profile.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

// Node's declarations omit samples that the current V8 protocol always returns.
declare module "node:inspector" {
  namespace HeapProfiler {
    interface SamplingHeapProfile {
      samples: SamplingProfile["samples"];
    }
  }
}

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "replica-owner": { type: "string" },
    "receipt-owner": { type: "string" },
    "start-at": { type: "string", default: "0" },
    iterations: { type: "string", default: "20000" },
    output: { type: "string" },
    golden: { type: "string" },
    profile: { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir must name a private benchmark directory");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1000,
  fallback: 20000,
});
const startAt = Number(values["start-at"]);
assert(Number.isSafeInteger(startAt) && startAt >= 0, "--start-at must be epoch milliseconds");
await mkdir(values["state-dir"], { recursive: true });
const stateDir = await mkdtemp(path.join(path.resolve(values["state-dir"]), "row-facts-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
const ownerUrl = values["replica-owner"]
  ? pathToFileURL(path.resolve(values["replica-owner"]))
  : new URL("../../src/config/sessions/session-actor-replica.ts", import.meta.url);
const receiptOwnerUrl = values["receipt-owner"]
  ? pathToFileURL(path.resolve(values["receipt-owner"]))
  : new URL("../../src/config/sessions/session-actor-receipt.ts", import.meta.url);
const [owner, receiptOwner, sqlite, admission] = await Promise.all([
  import(ownerUrl.href) as Promise<
    typeof import("../../src/config/sessions/session-actor-replica.js")
  >,
  import(receiptOwnerUrl.href) as Promise<
    typeof import("../../src/config/sessions/session-actor-receipt.js")
  >,
  import("../../src/infra/node-sqlite.js"),
  import("../../src/infra/sqlite-database-admission.js"),
]);
const sourceHash = hash("sha256", await readFile(ownerUrl), "hex");
const receiptSourceHash = hash("sha256", await readFile(receiptOwnerUrl), "hex");
const databasePath = path.join(stateDir, "admission.sqlite");
const database = sqlite.openNodeSqliteDatabase(databasePath);
const identity = admission.getSqliteDatabaseAdmissionIdentityForPath(databasePath);
assert(
  identity && identity.key.startsWith("file:"),
  "Replica requires admitted physical database identity",
);
const inspector = new Session();
inspector.connect();
const sessionCount = 32;
const replicas: Array<ReturnType<typeof owner.createSessionActorReplica>> = [];
const entries: InternalSessionEntry[] = [];
const retained: SessionRowDatabaseFacts[] = [];

function allocatedBytes(node: InspectorHeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocatedBytes(child), 0);
}

function ownerBytes(node: InspectorHeapProfiler.SamplingHeapProfileNode): number {
  return node.callFrame.functionName === "readSessionActorRowFacts"
    ? allocatedBytes(node)
    : node.children.reduce((sum, child) => sum + ownerBytes(child), 0);
}

function quantiles(samples: number[]) {
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
    maxMs: sorted.at(-1),
  };
}

async function writeJson(filename: string, value: unknown) {
  await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

try {
  for (let index = 0; index < sessionCount; index++) {
    const sessionKey = `agent:main:synthetic-row-${index}`;
    const sessionId = `synthetic-session-${index}`;
    const entry: InternalSessionEntry = {
      sessionId,
      updatedAt: 1000 + index,
      label: `Synthetic worker ${index}`,
      owner: { actor: { type: "agent", id: "main" }, assignedAt: 1 },
      participants: Array.from({ length: 4 }, (_, participant) => ({
        identity: { type: "agent", id: `synthetic-helper-${participant}` },
      })),
      activitySummary: {
        version: 1,
        text: `Synthetic work summary ${index}`,
        updatedAt: 1000 + index,
        sessionId,
        generation: "synthetic-generation",
        maxSeq: 12,
        leafEntryId: "synthetic-leaf",
        coveredMessages: 12,
        totalMessages: 12,
        omittedContent: false,
      },
      pluginExtensions: {
        synthetic: {
          work: Array.from({ length: 16 }, (_, item) => ({
            id: `synthetic-item-${item}`,
            title: `Synthetic tool result ${item}`,
            details: `Synthetic context ${index}/${item}: `.padEnd(192, "x"),
            tags: ["synthetic", "benchmark"],
          })),
        },
      },
      skillsSnapshot: {
        prompt: "Synthetic skill snapshot intentionally excluded from rows. ".repeat(512),
        skills: [],
      },
      ...(index % 4 === 0
        ? {
            pendingFinalDelivery: {
              kind: "replayable" as const,
              text: "Synthetic pending final. ".repeat(512),
              createdAt: 1000,
              intentId: `synthetic-intent-${index}`,
              deliveries: [{ id: "synthetic-delivery", state: "prepared" as const }],
            },
          }
        : {}),
    };
    const target = {
      sessionKey,
      database: {
        kind: "file" as const,
        physicalIdentity: identity.key.slice("file:".length),
        birthtime: identity.birthtime,
        nativeLocation: databasePath,
      },
    };
    const writeToken = admission.readSqliteDatabaseScopedWriteTokenForPath(databasePath, [
      sessionKey,
      admission.sqliteSessionIdWriteScope(sessionId),
    ]);
    assert(writeToken, "Replica requires a settled owner write token");
    const snapshot: SessionActorHotState = {
      target,
      version: { epoch: "synthetic-epoch", sequence: 1 },
      writeToken,
      dependencySessionIds: [sessionId],
      entry,
      hasBoard: false,
      participants: [],
      members: [],
      pendingInputs: [],
      completionKeys: [],
      transcript: {
        version: { generation: "synthetic-generation", rawSeq: 12, updatedAt: 1000 + index },
        watermark: { generation: "synthetic-generation", maxSeq: 12 },
        anchorsState: "unavailable",
        anchors: [],
        idempotency: [],
        modelContext: {
          kind: "unavailable",
          reason: "projection",
          generation: "synthetic-generation",
        },
      },
    };
    const replica = owner.createSessionActorReplica({
      target,
      lifetime: { assertCurrent() {}, assertReadable() {} },
      currentGeneration: () => "synthetic-incarnation",
    });
    assert(replica.beginRead()(snapshot), "Real replica owner rejected synthetic postimage");
    replicas.push(replica);
    entries.push(entry);
  }
  const read = (index: number) => {
    const slot = index % sessionCount;
    const facts = owner.readSessionActorRowFacts({
      path: databasePath,
      sessionKey: `agent:main:synthetic-row-${slot}`,
    });
    assert(facts, "Replica miss would invalidate the measured owner workload");
    retained[slot] = facts;
    return facts;
  };
  const golden = entries.map((_, index) => read(index));
  for (const [index, facts] of golden.entries()) {
    assert.equal(facts.entry.skillsSnapshot, undefined);
    assert.equal(facts.activitySummaryWatermark?.maxSeq, 12);
    facts.entry.label = "Caller-owned root edit";
    assert.equal(read(index).entry.label, entries[index]!.label);
    facts.entry.label = entries[index]!.label;
  }
  const goldenJson = JSON.stringify(golden);
  if (values.golden) {
    await writeJson(values.golden, golden);
  }
  for (let index = 0; index < 2000; index++) {
    read(index);
  }
  if (startAt) {
    assert(Date.now() < startAt, "Missed --start-at after setup and warmup");
    await delay(startAt - Date.now());
  }
  await inspector.post("HeapProfiler.collectGarbage");
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let index = 0; index < iterations; index++) {
    read(index);
  }
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const allBytes = allocatedBytes(profile.head);
  const attributedBytes = ownerBytes(profile.head);
  // Separate timings from allocation sampling overhead, which scales with allocation volume.
  const latency = Array.from({ length: iterations }, () => 0);
  await inspector.post("HeapProfiler.collectGarbage");
  const gc = new GCProfiler();
  gc.start();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    read(index);
    latency[index] = performance.now() - before;
  }
  const elapsedMs = performance.now() - started;
  const cpuUsed = process.cpuUsage(cpu);
  const gcStats = gc.stop()?.statistics ?? [];
  assert.equal(JSON.stringify(entries.map((_, index) => read(index))), goldenJson);
  const receiptPostimage = replicas[0]!.read();
  assert(
    receiptPostimage?.entry?.pendingFinalDelivery,
    "Receipt fixture requires pending delivery",
  );
  const makeReceipt = () =>
    receiptOwner.createSessionActorCommittedOutcome({
      phase: "completeTurn",
      command: { commandId: "synthetic-completion", phaseId: "synthetic-turn" },
      before: receiptPostimage,
      after: receiptPostimage,
      applied: { value: { kind: "bookkeeping" }, reducers: [] },
    });
  let receipt = makeReceipt();
  const receiptGolden = JSON.stringify({
    value: receipt.value,
    entry: receipt.receipt.postimage.entry,
    transcript: receipt.receipt.transcript,
  });
  const serializedReceiptBytes = serialize(receipt).byteLength;
  const duplicateFieldCount = Number(Object.hasOwn(receipt.receipt, "pendingFinalDelivery"));
  for (let index = 0; index < 2000; index++) {
    receipt = makeReceipt();
  }
  await inspector.post("HeapProfiler.collectGarbage");
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let index = 0; index < iterations; index++) {
    receipt = makeReceipt();
  }
  const { profile: receiptProfile } = await inspector.post("HeapProfiler.stopSampling");
  const receiptAllocatedBytes = allocatedBytes(receiptProfile.head);
  assert.equal(
    JSON.stringify({
      value: receipt.value,
      entry: receipt.receipt.postimage.entry,
      transcript: receipt.receipt.transcript,
    }),
    receiptGolden,
  );
  const result = {
    node: process.version,
    sourceHash,
    startAt,
    sessionCount,
    iterations,
    replicaAdoptions: replicas.length,
    warmupReads: 2000,
    retainedConsumerRows: retained.length,
    ownership: {
      deeplyFrozenEntryRoots: entries.filter(Object.isFrozen).length,
      sharedNestedPluginMetadata: golden.filter(
        (facts, index) => facts.entry.pluginExtensions === entries[index]!.pluginExtensions,
      ).length,
      sharedWatermarks: golden.filter(
        (facts, index) =>
          facts.activitySummaryWatermark === replicas[index]!.read()?.transcript.watermark,
      ).length,
    },
    fixtureEntryJsonBytes: entries.map((entry) => Buffer.byteLength(JSON.stringify(entry))),
    golden: { bytes: Buffer.byteLength(goldenJson), sha256: hash("sha256", goldenJson, "hex") },
    allocation: {
      samples: profile.samples.length,
      samplingInterval: 512,
      includeCollected: true,
      bytes: allBytes,
      bytesPerRead: allBytes / iterations,
      ownerBytes: attributedBytes,
      ownerBytesPerRead: attributedBytes / iterations,
    },
    receipt: {
      sourceHash: receiptSourceHash,
      iterations,
      warmupReceipts: 2000,
      serializedBytesPerOutcome: serializedReceiptBytes,
      duplicatePendingFinalDeliveryFields: duplicateFieldCount,
      canonicalPendingFinalDeliveryFields: 1,
      pendingFinalDeliveryJsonBytes: Buffer.byteLength(
        JSON.stringify(receiptPostimage.entry.pendingFinalDelivery),
      ),
      canonicalGolden: {
        bytes: Buffer.byteLength(receiptGolden),
        sha256: hash("sha256", receiptGolden, "hex"),
      },
      allocation: {
        samples: receiptProfile.samples.length,
        samplingInterval: 512,
        includeCollected: true,
        bytes: receiptAllocatedBytes,
        bytesPerReceipt: receiptAllocatedBytes / iterations,
      },
    },
    timing: { elapsedMs, cpuMs: (cpuUsed.user + cpuUsed.system) / 1000, ...quantiles(latency) },
    gc: ["Scavenge", "MinorMarkSweep", "MarkSweepCompact", "IncrementalMarking"].map((kind) => {
      const durations = gcStats
        .filter((entry) => entry.gcType === kind)
        .map((entry) => entry.cost / 1000);
      return Object.assign(
        { kind, totalMs: durations.reduce((sum, ms) => sum + ms, 0) },
        quantiles(durations),
      );
    }),
    scope:
      "Owner-only replica adoption/read; no Gateway, RPC, or production allocation-share claim",
  };
  if (values.profile) {
    await writeJson(values.profile, profile);
    await writeJson(`${values.profile}.receipt.json`, receiptProfile);
  }
  if (values.output) {
    await writeJson(values.output, result);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const replica of replicas) {
    replica.invalidate();
    replica.close();
  }
  inspector.disconnect();
  database.close();
  await rm(stateDir, { recursive: true, force: true });
}
