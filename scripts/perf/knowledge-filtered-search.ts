/**
 * Knowledge filtered-search owner benchmark, synthetic records and real SQLite.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/knowledge-filtered-search.ts
 *   [--records 5000] [--selected 100] [--iterations 100] [--sample]
 *   [--source .local/retrieval-baseline.ts] [--body-repeats 400] [--writer-probe]
 *   [--journal DELETE|WAL]
 *
 * Alternate baseline/candidate processes, five timing arms each; sample allocation
 * separately (--sample includes collected objects). The fixture assumes 5,000
 * valid pages with ~1 KiB bodies; slow-call counts do not establish store size.
 * Setup and the initial index build are excluded. No Gateway or production state.
 * A fixed Date clock makes complete result digests comparable, including freshness. Native SQLite allocations
 * are outside the JS sampler. Database files live under .local and are removed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import type { LoadedRecord } from "../../extensions/knowledge/src/model.js";
import type { SearchInput } from "../../extensions/knowledge/src/retrieval-contract.js";
import type { ScanResult } from "../../extensions/knowledge/src/scan-result.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    records: { type: "string", default: "5000" },
    selected: { type: "string", default: "100" },
    iterations: { type: "string", default: "100" },
    source: { type: "string" },
    sample: { type: "boolean", default: false },
    "body-repeats": { type: "string", default: "20" },
    "writer-probe": { type: "boolean", default: false },
    journal: { type: "string", default: "WAL" },
  },
});
const integer = (name: "records" | "selected" | "iterations") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const bodyRepeats = parseStrictIntegerOption({
  raw: values["body-repeats"],
  label: "--body-repeats",
  min: 1,
  fallback: 20,
});
const count = integer("records"),
  selected = integer("selected"),
  iterations = integer("iterations");
assert(selected < count, "--selected must be smaller than --records");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const owner = new URL("../../extensions/knowledge/src/retrieval.ts", import.meta.url);
const source = values.source ? pathToFileURL(path.resolve(values.source)) : owner;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === source.href && specifier.startsWith(".")) {
      return nextResolve(new URL(specifier, owner).href, context);
    }
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
const { keywordSearch } = (await import(
  source.href
)) as typeof import("../../extensions/knowledge/src/retrieval.js");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const at = "2026-01-01T00:00:00.000Z";
mock.timers.enable({ apis: ["Date"], now: new Date(at) });
assert(values.journal === "DELETE" || values.journal === "WAL");
const records = Array.from({ length: count }, (_, n): LoadedRecord => {
  const id = `record_${String(n).padStart(6, "0")}`;
  const lifecycle = n % 20 === 0 && n + 1 < count ? "superseded" : "active";
  const title = n % 3 === 0 ? `Orchid ${n}` : `Record ${n}`;
  const body = `${"Synthetic knowledge about botany and gardening. ".repeat(bodyRepeats)}\n${n % 2 ? "orchid flower" : "violet flower"} ${n} ${lifecycle === "superseded" ? "ancestorword" : ""}`;
  const metadata: LoadedRecord["metadata"] = {
    format: "knowledge-record-v1",
    id,
    title,
    kind: "page",
    type: "note",
    revision: 1,
    scope: { visibility: "private" },
    recorded_at: at,
    updated_at: at,
    lifecycle,
    ...(lifecycle === "superseded"
      ? { superseded_by: `record_${String(n + 1).padStart(6, "0")}` }
      : {}),
    aliases: [`Flower ${n}`, `Café ${n}`],
    tags: n < selected ? ["selected"] : ["outside"],
  };
  const raw = `${JSON.stringify(metadata)}\n${body}`;
  return {
    id,
    title,
    kind: "page",
    type: "note",
    revision: 1,
    lifecycle,
    valid: true,
    path: `notes/${id}.md`,
    metadata,
    body,
    raw,
    hash: hash(raw),
  };
});
const data: ScanResult = {
  records,
  recall: new Map(),
  ontology: null,
  sources: [],
  issues: [],
  checkedAt: at,
};
const queries: SearchInput[] = [
  { query: "orchid", tag: "selected" },
  { query: "flower", tag: "selected", offset: 20, limit: 10 },
  { query: "orchid flower", tag: "selected", mode: "phrase" },
  { query: "cafe violet", tag: "selected", mode: "any" },
  { query: "ancestorword", tag: "selected", offset: 20, limit: 10 },
  { query: "missing", tag: "selected" },
];
fs.mkdirSync(path.join(repo, ".local"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(repo, ".local/knowledge-filtered-"));
const filename = path.join(scratch, "state.sqlite");
const db = new DatabaseSync(filename);
const signal = new Int32Array(new SharedArrayBuffer(16));
const writer = values["writer-probe"]
  ? new Worker(
      `
  const { workerData } = require("node:worker_threads");
  const { DatabaseSync } = require("node:sqlite");
  const signal = new Int32Array(workerData.signal);
  const db = new DatabaseSync(workerData.filename);
  db.exec("PRAGMA busy_timeout=30000");
  Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
  while (true) {
    Atomics.wait(signal, 0, 1);
    const start = performance.now();
    Atomics.store(signal, 0, 3); Atomics.notify(signal, 0);
    try {
      db.exec("BEGIN IMMEDIATE; INSERT INTO concurrent_writes DEFAULT VALUES; COMMIT");
      Atomics.store(signal, 1, Math.round((performance.now() - start) * 1000));
    } catch { Atomics.store(signal, 1, -1); }
    Atomics.store(signal, 2, 1); Atomics.notify(signal, 2);
    Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
  }
`,
      { eval: true, workerData: { filename, signal: signal.buffer } },
    )
  : undefined;
const writerWaitMs: number[] = [];
const holds: number[] = [];
let measuring = false,
  probe = false,
  began: number | undefined;
const exec = db.exec.bind(db);
db.exec = (sql) => {
  exec(sql);
  if (!measuring) {
    return;
  }
  if (sql === "BEGIN IMMEDIATE") {
    began = performance.now();
  }
  if (began !== undefined && (sql === "COMMIT" || sql === "ROLLBACK")) {
    holds.push(performance.now() - began);
    began = undefined;
  }
  if (writer && !probe && sql.startsWith("CREATE VIRTUAL TABLE temp.")) {
    probe = true;
    while (Atomics.load(signal, 0) !== 1) {
      Atomics.wait(signal, 0, Atomics.load(signal, 0), 30000);
    }
    Atomics.store(signal, 2, 0);
    Atomics.store(signal, 0, 2);
    Atomics.notify(signal, 0);
    Atomics.wait(signal, 0, 2, 30000);
  }
};
try {
  db.exec(
    `PRAGMA journal_mode=${values.journal}; CREATE TABLE concurrent_writes(id INTEGER PRIMARY KEY); CREATE TABLE keyword_state_v1(binding TEXT PRIMARY KEY,snapshot TEXT NOT NULL,indexed_at TEXT NOT NULL) STRICT`,
  );
  const search = (input: SearchInput) => {
    const result = keywordSearch(db, data, input, "synthetic", "generation");
    assert.equal(result.index.state, "ready");
    return result;
  };
  const digest = () => hash(JSON.stringify(queries.map(search)));
  const resultDigest = digest();
  for (let n = 0; n < 5; n++) {
    search(queries[n % queries.length]!);
  }
  globalThis.gc?.();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const gc: { start: number; ms: number; kind: number }[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const detail: unknown = "detail" in entry ? entry.detail : undefined;
      const kind =
        detail && typeof detail === "object" && "kind" in detail && typeof detail.kind === "number"
          ? detail.kind
          : 0;
      gc.push({ start: entry.startTime, ms: entry.duration, kind });
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const inspector = values.sample ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const memoryBefore = process.memoryUsage(),
    hostBefore = loadavg();
  const latencies: number[] = [];
  const cpuStart = process.cpuUsage(),
    start = performance.now();
  measuring = true;
  for (let n = 0; n < iterations; n++) {
    probe = false;
    const begin = performance.now();
    search(queries[n % queries.length]!);
    latencies.push(performance.now() - begin);
    if (writer) {
      assert(probe, "filtered search must exercise a temporary corpus");
      if (!Atomics.load(signal, 2)) {
        Atomics.wait(signal, 2, 0, 30000);
      }
      assert.equal(Atomics.load(signal, 2), 1, "writer did not finish");
      assert(Atomics.load(signal, 1) >= 0, "concurrent writer failed");
      writerWaitMs.push(Atomics.load(signal, 1) / 1000);
    }
  }
  measuring = false;
  const wallMs = performance.now() - start,
    cpu = process.cpuUsage(cpuStart);
  const memoryAfter = process.memoryUsage();
  const allocation = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  // GC PerformanceObserver entries are delivered on the following event-loop turn.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  observer.disconnect();
  const measuredGc = gc.filter((entry) => entry.start >= start && entry.start < start + wallMs);
  const pauses = measuredGc.map((entry) => entry.ms);
  assert.equal(digest(), resultDigest);
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      mode: values.sample ? "allocation" : "timing",
      records: count,
      bodyRepeats,
      journal: values.journal,
      corpusBytes: records.reduce((sum, record) => sum + Buffer.byteLength(record.raw), 0),
      writerWaitMs,
      writerHoldMs: holds,
      selected,
      iterations,
      resultDigest,
      hostBefore,
      hostAfter: loadavg(),
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      medianMs: latencies[Math.floor(iterations / 2)],
      p95Ms: latencies[Math.ceil(iterations * 0.95) - 1],
      gcCount: pauses.length,
      gcMs: pauses.reduce((sum, ms) => sum + ms, 0),
      gcMaxMs: Math.max(0, ...pauses),
      gcByKind: Object.fromEntries(
        [...new Set(measuredGc.map((entry) => entry.kind))].map((kind) => {
          const entries = measuredGc.filter((entry) => entry.kind === kind);
          return [
            kind,
            {
              count: entries.length,
              totalMs: entries.reduce((sum, entry) => sum + entry.ms, 0),
              maxMs: Math.max(...entries.map((entry) => entry.ms)),
            },
          ];
        }),
      ),
      rssBefore: memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      heapBefore: memoryBefore.heapUsed,
      heapAfter: memoryAfter.heapUsed,
      ...(allocation ? { sampledBytes: sumSampledHeapBytes(allocation.profile.head) } : {}),
    }),
  );
} finally {
  await writer?.terminate();
  db.close();
  mock.timers.reset();
  fs.rmSync(scratch, { recursive: true, force: true });
}
