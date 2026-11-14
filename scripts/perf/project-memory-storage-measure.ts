/**
 * Attribute Knowledge candidate work on the synthetic fixture created by
 * project-memory-bootstrap-measure.ts. Run serial A/A and A/B fresh processes:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/project-memory-storage-measure.ts
 *   --root <fixture> --iterations 20 [--allocation]
 * This runs the real storage owner locally to measure worker-side allocations
 * and scan/SQLite phases; it does not measure transport or caller admission.
 * Acceptance: identical candidate bytes, fewer filesystem operations, improved
 * warm p50/p95 and CPU, no >20% allocation or cold-start regression.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    iterations: { type: "string", default: "20" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values.root);
const root = path.resolve(values.root);
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const [{ KnowledgeStorage }, { SqliteIdentityStore }] = await Promise.all([
  import("../../extensions/knowledge/src/storage.ts"),
  import("../../extensions/knowledge/src/identity-store.ts"),
]);
let counts = { lstat: 0, readdir: 0, scanMs: 0, databaseMs: 0, authority: 0 };
fs.lstatSync = new Proxy(fs.lstatSync, {
  apply(target, receiver, args) {
    counts.lstat++;
    return Reflect.apply(target, receiver, args);
  },
});
fs.readdirSync = new Proxy(fs.readdirSync, {
  apply(target, receiver, args) {
    counts.readdir++;
    return Reflect.apply(target, receiver, args);
  },
});
syncBuiltinESMExports();
const identities = new SqliteIdentityStore(path.join(root, "knowledge.sqlite"));
identities.withDatabase = new Proxy(identities.withDatabase.bind(identities), {
  apply(target, receiver, args) {
    const started = performance.now();
    try {
      return Reflect.apply(target, receiver, args);
    } finally {
      counts.databaseMs += performance.now() - started;
    }
  },
});
const manifest = JSON.parse(fs.readFileSync(path.join(root, "vault/vault.json"), "utf8"));
const storage = new KnowledgeStorage(
  {
    root: path.join(root, "vault"),
    statePath: path.join(root, "knowledge.sqlite"),
    vaultId: manifest.vaultId,
    publicationId: manifest.publicationId,
    writesEnabled: false,
  },
  identities,
);
const storageRun = storage.run.bind(storage);
storage.run = (access, operation) =>
  storageRun(access, (vault) => {
    const scan = vault.scan.bind(vault);
    vault.scan = async (...args) => {
      const started = performance.now();
      try {
        return await scan(...args);
      } finally {
        counts.scanMs += performance.now() - started;
      }
    };
    return operation(vault);
  });
let expected: string | undefined;
const run = async () => {
  counts = { lstat: 0, readdir: 0, scanMs: 0, databaseMs: 0, authority: 0 };
  const cpu = process.cpuUsage();
  const started = performance.now();
  const result = await storage.memoryCandidates(
    { kind: "project", limit: 48 },
    {
      agentId: "main",
      scope: { visibility: "private" },
      assertCurrent() {
        counts.authority++;
      },
    },
  );
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const bytes = JSON.stringify(result);
  assert.equal(result.records.length, 48);
  expected ??= bytes;
  assert.equal(bytes, expected);
  return { wallMs, cpuMs: (used.user + used.system) / 1000, ...counts };
};
const cold = await run();
global.gc?.();
const inspector = new Session();
if (values.allocation) {
  await startCollectedHeapSampling(inspector, 4096);
}
const warm = [];
for (let i = 0; i < iterations; i++) {
  warm.push(await run());
}
let allocatedBytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = sumSampledHeapBytes(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    cold,
    warm,
    allocatedBytes,
    bytesPerOperation: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    candidateSha256: createHash("sha256").update(expected!).digest("hex"),
    hostLoad: loadavg(),
  }),
);
