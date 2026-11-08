/**
 * Uncontended transaction/pairing diagnostic cost (CPU and collected JS allocations).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/slow-wait-holder-measure.ts
 * Add --source-ref <base-sha> to replay just the changed diagnostic owners from that revision.
 * Run serial A/A then counterbalanced base/candidate passes; each process is <30 seconds.
 * 10k synthetic sessions, 5k transactions per sample, separate allocation pass; no Gateway claim.
 * Acceptance: report absolute per-operation overhead and A/A spread, no speedup claimed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({ options: { "source-ref": { type: "string" } } });
const revision = values["source-ref"];
if (revision) {
  assert(/^[a-f0-9]{40}$/.test(revision), "--source-ref requires a full commit SHA");
  const sources = new Map<string, string>();
  for (const filename of [
    "src/infra/sqlite-transaction.ts",
    "src/infra/sqlite-database-admission-context.ts",
    "src/infra/sqlite-database-admission-record.ts",
    "src/infra/device-pairing-lock.ts",
  ]) {
    sources.set(
      new URL(`../../${filename}`, import.meta.url).href,
      execFileSync("git", ["show", `${revision}:${filename}`], { encoding: "utf8" }),
    );
  }
  registerHooks({
    load(url, context, nextLoad) {
      const source = sources.get(url);
      return source === undefined
        ? nextLoad(url, context)
        : {
            format: "module-typescript",
            source,
            shortCircuit: true,
          };
    },
  });
}
assert(globalThis.gc, "Run with --expose-gc");
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
const { runSqliteImmediateTransactionSync } = await import("../../src/infra/sqlite-transaction.js");
const { withDevicePairingLock } = await import("../../src/infra/device-pairing-lock.js");
mkdirSync(".local", { recursive: true });
const directory = mkdtempSync(path.resolve(".local/holder-measure-"));
const db = openNodeSqliteDatabase(path.join(directory, "synthetic.sqlite"));
const iterations = 5_000;
let warnings = 0;
const options = {
  operationLabel: "session.entries.patch",
  logger: {
    warn() {
      warnings++;
    },
  },
};
try {
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; CREATE TABLE sessions (id INTEGER PRIMARY KEY, unread INTEGER)",
  );
  const insert = db.prepare("INSERT INTO sessions VALUES (?, 0)");
  runSqliteImmediateTransactionSync(db, () => {
    for (let index = 0; index < 10_000; index++) {
      insert.run(index);
    }
  });
  const update = db.prepare("UPDATE sessions SET unread=1-unread WHERE id=?");
  let next = 0;
  const transaction = () =>
    runSqliteImmediateTransactionSync(db, () => update.run(next++ % 10_000), options);
  const pairing = () => withDevicePairingLock(async () => {}, "devicePairing.ensureToken");
  const rows: object[] = [];
  for (const [name, run] of [
    ["transaction", transaction],
    ["pairing", pairing],
  ] as const) {
    for (let index = 0; index < 1_000; index++) {
      await run();
    }
    for (let sample = 0; sample < 3; sample++) {
      globalThis.gc();
      const cpu = process.threadCpuUsage();
      const start = performance.now();
      for (let index = 0; index < iterations; index++) {
        await run();
      }
      const usage = process.threadCpuUsage(cpu);
      rows.push({
        name,
        sample,
        iterations,
        cpuMs: (usage.user + usage.system) / 1000,
        wallMs: performance.now() - start,
        load: loadavg(),
      });
    }
    globalThis.gc();
    const inspector = new Session();
    await startCollectedHeapSampling(inspector, 1024);
    for (let index = 0; index < iterations; index++) {
      await run();
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    rows.push({ name, iterations, allocatedBytes: sumSampledHeapBytes(profile.head) });
  }
  assert.equal(warnings, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 10_000);
  console.log(
    JSON.stringify({ revision: revision ?? "candidate", node: process.version, rows }, null, 2),
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
