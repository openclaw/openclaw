/**
 * Synthetic Knowledge Git owner benchmark (real SQLite and Git; no Gateway).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/knowledge-git-transactions.ts
 *   [--iterations 2000] [--history 2000] [--jobs 10] [--sample]
 *   [--source /absolute/path/to/storage-base.ts]
 *   [--git-source /absolute/path/to/git-history.ts]
 *
 * Run timing and --sample allocation passes separately for each revision, in
 * alternating order. --source may select an adjacent baseline storage-base.ts
 * copy (relative imports must still resolve); otherwise run from each checkout.
 * Each arm creates and removes its own .local fixture. Setup is not measured.
 * Empty flushes see archived jobs/receipts; queued flushes commit 25 x 1 KiB
 * documents per job. Transaction holds include application work between BEGIN
 * and COMMIT, matching the slow-transaction diagnostic. CPU excludes Git child
 * processes; allocation samples include collected objects but exclude native
 * SQLite/Git allocations. This does not measure main-thread Gateway retention.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { VaultAccess } from "../../extensions/knowledge/src/access.js";
import type { GitChange } from "../../extensions/knowledge/src/git-history.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "git-source": { type: "string" },
    iterations: { type: "string", default: "2000" },
    history: { type: "string", default: "2000" },
    jobs: { type: "string", default: "10" },
    sample: { type: "boolean", default: false },
  },
});
const integer = (name: "iterations" | "history" | "jobs") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations"),
  history = integer("history"),
  jobs = integer("jobs");
const repo = fileURLToPath(new URL("../../", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    const prefix = "openclaw/plugin-sdk/";
    return nextResolve(
      specifier.startsWith(prefix)
        ? pathToFileURL(path.join(repo, "src/plugin-sdk", `${specifier.slice(prefix.length)}.ts`))
            .href
        : specifier,
      context,
    );
  },
});
const source = values.source
  ? pathToFileURL(path.resolve(values.source))
  : new URL("../../extensions/knowledge/src/storage-base.ts", import.meta.url);
const { StorageBase } = (await import(
  source.href
)) as typeof import("../../extensions/knowledge/src/storage-base.js");
const { SqliteIdentityStore } = await import("../../extensions/knowledge/src/identity-store.js");
const { GitHistory } = (await import(
  values["git-source"]
    ? pathToFileURL(path.resolve(values["git-source"])).href
    : new URL("../../extensions/knowledge/src/git-history.ts", import.meta.url).href
)) as typeof import("../../extensions/knowledge/src/git-history.js");
const access: VaultAccess = {
  agentId: "synthetic-benchmark",
  scope: { visibility: "private" },
  assertCurrent() {},
};
const holds: number[] = [];
let measuring = false;
class MeasuredStore extends SqliteIdentityStore {
  override withDatabase<T>(run: (db: DatabaseSync) => T): T {
    return super.withDatabase((db) => {
      const exec = db.exec.bind(db);
      let started: number | undefined;
      db.exec = (sql: string) => {
        const result = exec(sql);
        if (measuring && /^BEGIN\b/i.test(sql)) {
          started = performance.now();
        } else if (started !== undefined && /^(?:COMMIT|ROLLBACK)\b/i.test(sql)) {
          holds.push(performance.now() - started);
          started = undefined;
        }
        return result;
      };
      return run(db);
    });
  }
}
class GitBench extends StorageBase {
  flush() {
    this.flushGit(access);
  }
  enqueue(request: string, changes: GitChange[]) {
    this.store.withDatabase((db) => {
      this.enqueueGit(
        db,
        "private",
        changes,
        "synthetic benchmark",
        this.publicationToken("private", request),
      );
      db.prepare("INSERT INTO mutations VALUES (?,?,?,?,?,?)").run(
        "private",
        request,
        "synthetic",
        "published",
        "{}",
        JSON.stringify({ requestId: request }),
      );
    });
  }
}
const percentile = (samples: number[], quantile: number) =>
  samples.length
    ? samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * quantile) - 1]!
    : null;
async function measure(name: string, operations: number, run: () => void) {
  globalThis.gc?.();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const gcEntries: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((entries) => {
    gcEntries.push(...entries.getEntries());
  });
  observer.observe({ entryTypes: ["gc"] });
  const inspector = values.sample ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  holds.length = 0;
  const memoryBefore = process.memoryUsage(),
    hostLoadBefore = loadavg(),
    cpuStart = process.cpuUsage(),
    start = performance.now();
  measuring = true;
  try {
    run();
  } finally {
    measuring = false;
  }
  const wallMs = performance.now() - start,
    cpu = process.cpuUsage(cpuStart),
    memoryAfter = process.memoryUsage();
  const allocation = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  gcEntries.push(...observer.takeRecords());
  observer.disconnect();
  const gc = gcEntries
    .filter((entry) => entry.startTime >= start && entry.startTime < start + wallMs)
    .map((entry) => entry.duration);
  console.log(
    JSON.stringify({
      name,
      mode: values.sample ? "allocation" : "timing",
      source: source.href,
      gitSource: values["git-source"] ?? "extensions/knowledge/src/git-history.ts",
      operations,
      history,
      jobs,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuUsPerOperation: (cpu.user + cpu.system) / operations,
      transactions: holds.length,
      transactionTotalMs: holds.reduce((sum, ms) => sum + ms, 0),
      transactionP99Ms: percentile(holds, 0.99),
      transactionMaxMs: holds.length ? Math.max(...holds) : null,
      gcCount: gc.length,
      gcTotalMs: gc.reduce((sum, ms) => sum + ms, 0),
      gcMaxMs: gc.length ? Math.max(...gc) : null,
      rssBefore: memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      heapBefore: memoryBefore.heapUsed,
      heapAfter: memoryAfter.heapUsed,
      ...(allocation
        ? {
            sampledBytes: sumSampledHeapBytes(allocation.profile.head),
            sampledBytesPerOperation: sumSampledHeapBytes(allocation.profile.head) / operations,
          }
        : {}),
    }),
  );
}
fs.mkdirSync(path.join(repo, ".local"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(repo, ".local/knowledge-git-bench-"));
try {
  const root = path.join(scratch, "vault");
  fs.mkdirSync(path.join(root, "private"), { recursive: true });
  const manifest = {
    format: "knowledge-vault-v2" as const,
    vaultId: randomUUID(),
    generation: 0,
    publicationId: randomUUID(),
  };
  fs.writeFileSync(path.join(root, "vault.json"), JSON.stringify(manifest));
  const config = {
    root,
    statePath: path.join(scratch, "state.sqlite"),
    ...manifest,
    writesEnabled: true,
  };
  const store = new MeasuredStore(config.statePath);
  await store.registerIfAbsent(`store:${manifest.vaultId}`, manifest);
  const bench = new GitBench(config, store, undefined, new GitHistory(root));
  store.withDatabase((db) => {
    db.exec("BEGIN IMMEDIATE");
    const job = db.prepare(
        "INSERT INTO git_jobs(scope,token,batch,state,message) VALUES (?,?,?,'committed','synthetic history')",
      ),
      receipt = db.prepare("INSERT INTO mutations VALUES (?,?,'synthetic','published',?,?)");
    for (let n = 0; n < history; n++) {
      job.run(
        "private",
        `archived-${n}`,
        JSON.stringify({
          changes: [{ path: `private/history-${n}.md`, raw: "archived".repeat(128) }],
        }),
      );
      receipt.run(
        "private",
        `archived-${n}`,
        JSON.stringify({ text: "historical plan".repeat(256) }),
        JSON.stringify({ requestId: `archived-${n}` }),
      );
    }
    db.exec("COMMIT");
  });
  for (let n = 0; n < 20; n++) {
    bench.flush();
  }
  await measure("empty-flush", iterations, () => {
    for (let n = 0; n < iterations; n++) {
      bench.flush();
    }
  });
  const expected = new Map<string, string>();
  for (let job = 0; job < jobs; job++) {
    const changes = Array.from({ length: 25 }, (_, doc) => {
      const filename = `private/job-${job}-${doc}.md`,
        raw = `Synthetic ${job}/${doc}\n` + "body\n".repeat(200);
      fs.writeFileSync(path.join(root, filename), raw);
      expected.set(
        filename,
        createHash("sha1")
          .update(`blob ${Buffer.byteLength(raw)}\0`)
          .update(raw)
          .digest("hex"),
      );
      return { path: filename, raw };
    });
    bench.enqueue(`job-${job}`, changes);
  }
  await measure("queued-flush", jobs, () => bench.flush());
  store.withDatabase((db) => {
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM git_jobs WHERE state!='committed'").get()!.n,
      0,
    );
    for (const row of db
      .prepare("SELECT receipt FROM mutations WHERE request LIKE 'job-%'")
      .all()) {
      assert.equal(JSON.parse(String(row.receipt)).git.state, "committed");
    }
  });
  const tree = spawnSync("git", ["--git-dir", path.join(root, ".git"), "ls-tree", "-r", "HEAD"], {
    encoding: "utf8",
  });
  assert.equal(tree.status, 0, tree.stderr);
  const actual = new Map(
    tree.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [fields, filename] = line.split("\t");
        return [filename!, fields!.split(" ")[2]!] as const;
      }),
  );
  assert.deepEqual(actual, expected, "Git tree contains every exact synthetic document");
  console.log(JSON.stringify({ verifiedDocuments: expected.size, pendingJobs: 0 }));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
