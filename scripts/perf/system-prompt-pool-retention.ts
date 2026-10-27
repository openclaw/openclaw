// Run separately on baseline and candidate with Node 26 --expose-gc --import ./scripts/tsx.mjs.
// Analyze the synthetic snapshots externally; primitive string equality cannot prove sharing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import type { CustomEntry } from "../../src/agents/sessions/session-manager-types.js";
import { shareSessionSystemPrompt } from "../../src/agents/sessions/system-prompt-pool.js";
import { drainGlobalSingletonLifecycleState } from "../../src/shared/global-singleton.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const MIB = 1024 * 1024;
const cases = {
  "count-pressure": { uniqueValues: 80, totalCharacters: 80 * 2048, cohorts: 3 },
  "byte-pressure": { uniqueValues: 40, totalCharacters: 40 * 160 * 1024, cohorts: 3 },
  representative: { uniqueValues: 95, totalCharacters: 14 * MIB, cohorts: 3 },
  "unique-only": { uniqueValues: 95, totalCharacters: 14 * MIB, cohorts: 1 },
} as const;
type Scenario = { uniqueValues: number; totalCharacters: number; cohorts: number };
type Checkpoint = CustomEntry<{
  prefix: string;
  renderedPrefix: string;
  hash: string;
  routeKey: string;
  historyId: null;
  restart: boolean;
}>;

// A named synthetic owner makes its fileEntries visible to the existing retention analyzer.
class SystemPromptPoolRetentionOwner {
  fileEntries: Checkpoint[] = [];
}

const { values } = parseArgs({
  options: {
    case: { type: "string", default: "representative" },
    samples: { type: "string", default: "2" },
    variant: { type: "string" },
    "output-dir": { type: "string" },
  },
});
const caseName = values.case;
assert(Object.hasOwn(cases, caseName), `Unknown case: ${caseName}`);
const scenario = cases[caseName as keyof typeof cases];
const samples = parseStrictIntegerOption({
  raw: values.samples,
  label: "--samples",
  min: 2,
  fallback: 2,
});
assert(samples <= 4, "Use at most 4 samples");
assert(values.variant && /^[a-z0-9-]+$/.test(values.variant), "Provide a simple --variant label");
assert(values["output-dir"], "Provide a new --output-dir");
assert(global.gc, "Run with --expose-gc");
const outputDir = path.resolve(values["output-dir"]);
process.umask(0o077);
// Refuse existing directories so another variant's evidence cannot be overwritten.
await mkdir(outputDir, { mode: 0o700 });

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function decodeCheckpoint(index: number, cohort: number, shape: Scenario): Checkpoint {
  const length =
    Math.floor(shape.totalCharacters / shape.uniqueValues) +
    (index < shape.totalCharacters % shape.uniqueValues ? 1 : 0);
  const bytes = Buffer.alloc(length, 65 + (index % 26));
  bytes.write(`## Synthetic prompt ${index}\n`, "ascii");
  const prefix = bytes.toString("ascii");
  const entry: Checkpoint = {
    type: "custom",
    customType: "openclaw.system-prompt",
    id: `checkpoint-${cohort}-${index}`,
    parentId: null,
    timestamp: "2026-10-01T00:00:00Z",
    data: {
      prefix,
      renderedPrefix: prefix,
      hash: sha256(prefix),
      routeKey: "synthetic/model",
      historyId: null,
      restart: true,
    },
  };
  // Each call crosses an independent decode boundary; no source strings survive this helper.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise the transcript JSON decode boundary.
  return JSON.parse(JSON.stringify(entry)) as Checkpoint;
}

function createOwners(shape: Scenario) {
  const owners: SystemPromptPoolRetentionOwner[] = [];
  const expected = createHash("sha256");
  const actual = createHash("sha256");
  for (let cohort = 0; cohort < shape.cohorts; cohort++) {
    const owner = new SystemPromptPoolRetentionOwner();
    owners.push(owner);
    // Sequential cohorts exceed the old LRU's reuse distance while prior cohorts remain live.
    for (let index = 0; index < shape.uniqueValues; index++) {
      const decoded = decodeCheckpoint(index, cohort, shape);
      expected.update(JSON.stringify(decoded));
      const shared = shareSessionSystemPrompt(decoded);
      actual.update(JSON.stringify(shared));
      assert(Object.isFrozen(shared.data));
      owner.fileEntries.push(shared);
    }
  }
  const expectedDigest = expected.digest("hex");
  const actualDigest = actual.digest("hex");
  assert.equal(actualDigest, expectedDigest, "Sharing changed checkpoint contents");
  return {
    owners,
    weakOwners: owners.map((owner) => new WeakRef(owner)),
    expectedDigest,
    actualDigest,
  };
}

async function collect() {
  for (let pass = 0; pass < 4; pass++) {
    await nextTurn();
    global.gc!();
  }
}

let snapshotBytes = 0;
async function capture(sample: number, phase: string) {
  await collect();
  const { heapUsed, external, arrayBuffers, rss } = process.memoryUsage();
  const snapshot = `${sample}-${phase}.heapsnapshot`;
  writeHeapSnapshot(path.join(outputDir, snapshot));
  const bytes = (await stat(path.join(outputDir, snapshot))).size;
  snapshotBytes += bytes;
  assert(snapshotBytes < 1024 * MIB, "Snapshot artifacts exceeded the 1 GiB run budget");
  return { phase, snapshot, snapshotBytes: bytes, heapUsed, external, arrayBuffers, rss };
}

// Warm the same construction and production paths without retaining the warmup's owner or pool.
createOwners({ uniqueValues: 1, totalCharacters: 2048, cohorts: 1 });
await drainGlobalSingletonLifecycleState("restart");
await collect();

const results = [];
for (let sample = 1; sample <= samples; sample++) {
  await drainGlobalSingletonLifecycleState("restart");
  const empty = await capture(sample, "empty");
  const batch = createOwners(scenario);
  const live = await capture(sample, "live");
  assert.equal(batch.owners.length, scenario.cohorts);
  assert.equal(
    batch.owners.reduce((total, owner) => total + owner.fileEntries.length, 0),
    scenario.uniqueValues * scenario.cohorts,
  );
  batch.owners.length = 0;
  const idle = await capture(sample, "idle");
  const survivingOwners = batch.weakOwners.filter((owner) => owner.deref() !== undefined).length;
  assert.equal(survivingOwners, 0, "The benchmark retained a dropped owner");
  await drainGlobalSingletonLifecycleState("restart");
  const reset = await capture(sample, "reset");
  const result = {
    sample,
    expectedDigest: batch.expectedDigest,
    actualDigest: batch.actualDigest,
    survivingOwners,
    liveOwnerAndPoolHeapDelta: live.heapUsed - empty.heapUsed,
    idlePoolHeapDelta: idle.heapUsed - empty.heapUsed,
    resetHeapDelta: reset.heapUsed - empty.heapUsed,
    snapshots: [empty, live, idle, reset],
  };
  results.push(result);
  console.log(JSON.stringify({ variant: values.variant, case: caseName, ...result }));
}

const report = {
  variant: values.variant,
  case: caseName,
  node: process.versions.node,
  samples,
  ...scenario,
  checkpointRecords: scenario.uniqueValues * scenario.cohorts,
  promptPropertyReferences: scenario.uniqueValues * scenario.cohorts * 2,
  conservativeUniqueUtf16Bytes: scenario.totalCharacters * 2,
  snapshotBytes,
  interpretation:
    "Synthetic owner stress, not a production savings prediction. Heap deltas include owner and pool; " +
    "external snapshot analysis must count distinct prefix/renderedPrefix string nodes and bytes. " +
    "Equal digests prove unchanged contents, not physical sharing. ASCII character counts are not measured shallow bytes.",
  results,
};
await writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
