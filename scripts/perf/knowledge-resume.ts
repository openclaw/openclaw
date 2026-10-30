/**
 * Knowledge resume owner benchmark: real SQLite, publication files and fsyncs.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/knowledge-resume.ts
 *   [--source /absolute/path/to/storage-journal.ts] [--iterations 5]
 *   [--history 10000] [--records 100] [--replays 0] [--sample]
 *
 * Alternate base/candidate timing runs, then repeat with --sample for allocation.
 * --source can be a baseline copy under .local: its sibling imports resolve to
 * the current Knowledge owner directory. Only storage-journal.ts is substituted.
 * --replays 2000 adds a separate already-published replay pass; use --records 1
 * for a small replay workload or retain 100 to exercise a multi-MiB journal plan.
 *
 * Each arm seeds a private .local fixture and removes it afterward. Setup is
 * excluded. Accepted recovery runs with writesEnabled=false, omitting the Git
 * outbox/drain while retaining real file publication and durable SQL settlement.
 * There is one accepted request at a time, as the publisher contract requires.
 * Authority is a no-op counter here: main-thread authority IPC delay and Gateway
 * behavior are not measured. SQL time covers prepare and statement execution.
 * Transaction holds include application work between BEGIN and COMMIT. Heap
 * sampling includes collected objects, excluding native SQLite allocations;
 * instrumentation overhead is present in both arms. Tails with few samples are
 * context only. Query plans prove access paths, not runtime rows-scanned counts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { VaultAccess } from "../../extensions/knowledge/src/access.js";
import type { Envelope, LoadedRecord } from "../../extensions/knowledge/src/model.js";
import type { FileChange } from "../../extensions/knowledge/src/publication-files.js";
import type { Plan } from "../../extensions/knowledge/src/storage-types.js";
import type { Manifest } from "../../extensions/knowledge/src/store-manifest.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    iterations: { type: "string", default: "5" },
    history: { type: "string", default: "10000" },
    records: { type: "string", default: "100" },
    replays: { type: "string", default: "0" },
    sample: { type: "boolean", default: false },
  },
});
const integer = (name: "iterations" | "history" | "records" | "replays", min = 1) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const iterations = integer("iterations"),
  history = integer("history", 0),
  recordCount = integer("records"),
  replays = integer("replays", 0);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const owner = new URL("../../extensions/knowledge/src/", import.meta.url);
const source = values.source
  ? pathToFileURL(path.resolve(values.source))
  : new URL("storage-journal.ts", owner);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const prefix = "openclaw/plugin-sdk/";
    if (specifier.startsWith(prefix)) {
      return nextResolve(
        pathToFileURL(path.join(repo, "src/plugin-sdk", `${specifier.slice(prefix.length)}.ts`))
          .href,
        context,
      );
    }
    if (context.parentURL === source.href && specifier.startsWith("./")) {
      return nextResolve(new URL(specifier.replace(/\.js$/, ".ts"), owner).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { StorageJournal } = (await import(
  source.href
)) as typeof import("../../extensions/knowledge/src/storage-journal.js");
const { SqliteIdentityStore } = await import("../../extensions/knowledge/src/identity-store.js");
const { PublicationFiles } = await import("../../extensions/knowledge/src/publication-files.js");
const { describeSource } = await import("../../extensions/knowledge/src/source-descriptors.js");
const { digest } = await import("../../extensions/knowledge/src/vault.js");

const counters = () => ({
  holds: [] as number[],
  sqlMs: 0,
  sqlCalls: 0,
  authorityCalls: 0,
});
let measured: ReturnType<typeof counters> | undefined;
class MeasuredStore extends SqliteIdentityStore {
  override withDatabase<T>(run: (db: DatabaseSync) => T): T {
    return super.withDatabase((db) => {
      const exec = db.exec.bind(db),
        prepare = db.prepare.bind(db);
      let holdStart: number | undefined;
      db.exec = (sql) => {
        const start = performance.now();
        const result = exec(sql);
        if (measured) {
          measured.sqlMs += performance.now() - start;
          measured.sqlCalls++;
          if (/^BEGIN\b/i.test(sql)) {
            holdStart = performance.now();
          }
          if (holdStart !== undefined && /^(?:COMMIT|ROLLBACK)\b/i.test(sql)) {
            measured.holds.push(performance.now() - holdStart);
            holdStart = undefined;
          }
        }
        return result;
      };
      db.prepare = (sql) => {
        const prepareStart = performance.now(),
          statement = prepare(sql);
        if (measured) {
          measured.sqlMs += performance.now() - prepareStart;
        }
        return new Proxy(statement, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") {
              return value;
            }
            return (...args: unknown[]): unknown => {
              const start = performance.now();
              try {
                return Reflect.apply(value, target, args);
              } finally {
                if (measured) {
                  measured.sqlMs += performance.now() - start;
                  measured.sqlCalls++;
                }
              }
            };
          },
        });
      };
      return run(db);
    });
  }
}
const access: VaultAccess = {
  scope: { visibility: "private" },
  agentId: "synthetic-benchmark",
  assertCurrent() {
    if (measured) {
      measured.authorityCalls++;
    }
  },
};
const sum = (samples: number[]) => samples.reduce((total, value) => total + value, 0);
const maximum = (samples: number[]) => (samples.length ? Math.max(...samples) : 0);
const percentile = (samples: number[], fraction: number) =>
  samples.length ? samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1]! : 0;
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + sum(node.children.map(sampledBytes));
}
async function measure(name: string, operations: number, run: () => void) {
  globalThis.gc?.();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const entries: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((batch) => entries.push(...batch.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const inspector = values.sample ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const stats = counters(),
    memoryBefore = process.memoryUsage(),
    hostLoadBefore = loadavg();
  const cpuStart = process.cpuUsage(),
    start = performance.now();
  measured = stats;
  try {
    run();
  } finally {
    measured = undefined;
  }
  const wallMs = performance.now() - start,
    cpu = process.cpuUsage(cpuStart),
    memoryAfter = process.memoryUsage();
  const allocation = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  entries.push(...observer.takeRecords());
  observer.disconnect();
  const pauses = entries
    .filter((entry) => entry.startTime >= start && entry.startTime < start + wallMs)
    .map((entry) => entry.duration);
  const result = {
    name,
    mode: values.sample ? "allocation" : "timing",
    operations,
    source: source.href,
    history,
    records: recordCount,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sqlMs: stats.sqlMs,
    sqlCalls: stats.sqlCalls,
    authorityCalls: stats.authorityCalls,
    transactions: stats.holds.length,
    transactionTotalMs: sum(stats.holds),
    transactionMaxMs: maximum(stats.holds),
    transactionMedianMs: percentile(stats.holds, 0.5),
    transactionP95Ms: percentile(stats.holds, 0.95),
    transactionP99Ms: percentile(stats.holds, 0.99),
    gcCount: pauses.length,
    gcTotalMs: sum(pauses),
    gcMaxMs: maximum(pauses),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    rssBefore: memoryBefore.rss,
    rssAfter: memoryAfter.rss,
    heapBefore: memoryBefore.heapUsed,
    heapAfter: memoryAfter.heapUsed,
    ...(allocation ? { sampledBytes: sampledBytes(allocation.profile.head) } : {}),
  };
  console.log(JSON.stringify(result));
  return result;
}

fs.mkdirSync(path.join(repo, ".local"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(repo, ".local/knowledge-resume-"));
try {
  const root = path.join(scratch, "vault");
  fs.mkdirSync(path.join(root, "private", "artifacts", "sources"), { recursive: true });
  let manifest: Manifest = {
    format: "knowledge-vault-v2",
    vaultId: randomUUID(),
    generation: 0,
    publicationId: randomUUID(),
  };
  fs.writeFileSync(path.join(root, "vault.json"), JSON.stringify(manifest));
  const config = {
    root,
    statePath: path.join(scratch, "state.sqlite"),
    ...manifest,
    writesEnabled: false,
  };
  const store = new MeasuredStore(config.statePath);
  await store.registerIfAbsent(`store:${manifest.vaultId}`, manifest);
  store.withDatabase((db) => {
    db.exec("BEGIN");
    const mutation = db.prepare("INSERT INTO mutations VALUES (?,?,'synthetic','published',?,?)");
    const revision = db.prepare(
      "INSERT INTO history(scope,id,provenance,at,path,revision,hash,raw) VALUES (?,?,?,?,?,?,?,?)",
    );
    const raw = "historical synthetic content\n".repeat(160);
    for (let i = 0; i < history; i++) {
      mutation.run("private", `history-${i}`, JSON.stringify({ synthetic: raw }), "{}");
      revision.run(
        "private",
        `history-${i}`,
        "agent",
        "2026-01-01T00:00:00.000Z",
        `history-${i}.md`,
        1,
        digest(raw),
        raw,
      );
    }
    db.exec("COMMIT");
    console.log(
      JSON.stringify({
        name: "query-plans",
        history,
        mutation: db
          .prepare("EXPLAIN QUERY PLAN SELECT * FROM mutations WHERE scope=? AND request=?")
          .all("private", "target"),
        identity: db
          .prepare("EXPLAIN QUERY PLAN SELECT manifest FROM identities WHERE agent_key=?")
          .all(`store:${manifest.vaultId}`),
      }),
    );
  });
  const storage = new StorageJournal(config, store);
  const results: Awaited<ReturnType<typeof measure>>[] = [];
  let lastRequest = "";
  for (let trial = 0; trial < iterations; trial++) {
    const request = randomUUID(),
      records: LoadedRecord[] = [],
      changes: FileChange[] = [];
    lastRequest = request;
    const sourceRaw = `Synthetic source for publication ${trial}.\n`;
    const evidence = {
      path: `artifacts/source-${trial}.txt`,
      sha256: digest(sourceRaw),
      attribution: "Synthetic benchmark",
    };
    const descriptor = describeSource(evidence);
    fs.writeFileSync(path.join(root, "private", evidence.path), sourceRaw);
    fs.writeFileSync(path.join(root, "private", descriptor.path), descriptor.raw);
    for (let i = 0; i < recordCount; i++) {
      const id = randomUUID(),
        body = "synthetic knowledge\n".repeat(1024);
      const metadata: Envelope = {
        format: "knowledge-record-v1",
        id,
        revision: 1,
        kind: "page",
        title: "Synthetic record",
        scope: { visibility: "private" },
        recorded_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        lifecycle: "active",
        type: "note",
        evidence: [{ ...evidence, source: descriptor.id }],
      };
      const raw = `---\n${JSON.stringify(metadata)}\n---\n${body}`,
        relative = `trial-${trial}-record-${i}.md`;
      records.push({
        id,
        path: relative,
        revision: 1,
        hash: digest(raw),
        raw,
        body,
        metadata,
        lifecycle: "active",
        valid: true,
        kind: "page",
        type: "note",
        title: metadata.title,
      });
      changes.push({
        path: `private/${relative}`,
        before: null,
        after: raw,
        backup: `private/.knowledge-history/${request}/${i}.before`,
        stage: `private/.knowledge-history/${request}/${i}.stage`,
      });
    }
    const after = { ...manifest, generation: manifest.generation + 1, publicationId: randomUUID() };
    changes.push({
      path: "vault.json",
      before: fs.readFileSync(path.join(root, "vault.json"), "utf8"),
      after: JSON.stringify(after),
      backup: `private/.knowledge-history/${request}/${recordCount}.before`,
      stage: `private/.knowledge-history/${request}/${recordCount}.stage`,
    });
    const plan: Plan = {
      rootIdentity: new PublicationFiles(root).identity(),
      before: manifest,
      after,
      changes,
      scope: "private",
      actor: "agent",
      agentId: access.agentId,
      record: records[0]!,
      records,
      descriptors: { [descriptor.path]: descriptor.raw },
    };
    const serialized = JSON.stringify(plan);
    store.withDatabase((db) =>
      db
        .prepare("INSERT INTO mutations VALUES (?,?,?,?,?,?)")
        .run(
          "private",
          request,
          "synthetic",
          "accepted",
          serialized,
          JSON.stringify({ requestId: request, state: "accepted" }),
        ),
    );
    console.log(
      JSON.stringify({
        name: "fixture",
        trial,
        planBytes: Buffer.byteLength(serialized),
        files: changes.length,
      }),
    );
    results.push(
      await measure("accepted", 1, () =>
        assert.equal(storage.resume(access, request).state, "published"),
      ),
    );
    for (const change of changes) {
      assert.equal(fs.readFileSync(path.join(root, change.path), "utf8"), change.after);
    }
    manifest = after;
  }
  console.log(
    JSON.stringify({
      name: "accepted-summary",
      publications: results.length,
      wallMs: sum(results.map((r) => r.wallMs)),
      cpuMs: sum(results.map((r) => r.cpuMs)),
      maxHoldPerPublicationMs: results.map((r) => r.transactionMaxMs),
      sqlMs: sum(results.map((r) => r.sqlMs)),
      gcTotalMs: sum(results.map((r) => r.gcTotalMs)),
      gcMaxMs: maximum(results.map((r) => r.gcMaxMs)),
      ...(values.sample ? { sampledBytes: sum(results.map((r) => r.sampledBytes ?? 0)) } : {}),
    }),
  );
  if (replays) {
    await measure("published-replay", replays, () => {
      for (let i = 0; i < replays; i++) {
        assert.equal(storage.resume(access, lastRequest).state, "published");
      }
    });
  }
  store.withDatabase((db) =>
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM history WHERE provenance='agent'").get()!.n,
      history + iterations * recordCount,
    ),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
