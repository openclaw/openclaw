/**
 * Synthetic schema-41 backfill proof. Usage and fixture commands are in
 * transcript-facts-backfill.md. Runs the production batch and hydration owners;
 * this is owner proof, not a Gateway admission, shutdown, or transport benchmark.
 * --start-position selects an inclusive active position for offline tail seeding.
 * --duty-ratio 20 models owner pacing from measured BEGIN-through-COMMIT wall;
 * actual host-returned delays and contention require the foreground probe.
 * --compare-hydration --baseline-tail-rows 512 retains the recent active-path facts
 * in baseline arms; the default zero compares empty versus complete coverage.
 * node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-backfill.ts \
 *   --output .local/facts-backfill --name ten-million --label paced --pause-ms 250
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod";
import { hydrateSessionActorState } from "../../src/config/sessions/session-actor-hydration.worker.js";
import {
  backfillTranscriptActiveFactsBatchInTransaction,
  discoverTranscriptActiveFactsBackfillSessions,
} from "../../src/config/sessions/session-transcript-active-facts-backfill.worker.js";
import { enableNodeSqliteKyselyStatementCache } from "../../src/infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { admitSqliteSchema } from "../../src/infra/sqlite-schema-facts.js";
import { configureSqliteWalMaintenance } from "../../src/infra/sqlite-wal.js";
import {
  readOpenClawAgentDatabaseIdentity,
  registerOpenClawAgentDatabaseIdentity,
} from "../../src/state/openclaw-agent-db-identity.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    name: { type: "string", default: "ten-million" },
    label: { type: "string" },
    session: { type: "string", default: "synthetic-0" },
    "pause-ms": { type: "string", default: "250" },
    "duty-ratio": { type: "string", default: "0" },
    "start-position": { type: "string", default: "0" },
    "max-batches": { type: "string", default: "0" },
    "allocation-iterations": { type: "string", default: "100" },
    "skip-hydration": { type: "boolean", default: false },
    "skip-backfill": { type: "boolean", default: false },
    "compare-hydration": { type: "boolean", default: false },
    "baseline-tail-rows": { type: "string", default: "0" },
  },
});
assert(values.output && values.label, "--output and a unique --label are required");
assert(/^[a-z0-9-]+$/u.test(values.name) && /^[a-z0-9-]+$/u.test(values.label));
assert(/^synthetic-\d+$/u.test(values.session), "Only synthetic fixture sessions are allowed");
const positive = (value: string) => {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number >= 0);
  return number;
};
const pauseMs = positive(values["pause-ms"]);
const dutyRatio = positive(values["duty-ratio"]);
const startPosition = positive(values["start-position"]);
const maxBatches = positive(values["max-batches"]);
const allocationIterations = positive(values["allocation-iterations"]);
const baselineTailRows = positive(values["baseline-tail-rows"]);
const output = path.resolve(values.output);
const fixture = path.join(output, `${values.name}.sqlite`);
const prefix = path.join(output, `${values.name}-${values.label}`);
const fixtureReport = z
  .object({
    rows: z.number().int().positive(),
    name: z.string(),
    finalization: z
      .object({ sessions: z.array(z.object({ session_id: z.string() })).optional() })
      .optional(),
  })
  .parse(JSON.parse(fs.readFileSync(path.join(output, `${values.name}-fixture.json`), "utf8")));
assert.equal(fixtureReport.name, values.name);
assert(
  values["skip-hydration"] ||
    values.session === "synthetic-0" ||
    fixtureReport.finalization?.sessions?.some((session) => session.session_id === values.session),
  "The selected path must be finalized for hydration in the fixture report",
);
assert(!fs.existsSync(`${prefix}.json`) && !fs.existsSync(`${prefix}.jsonl`));
fs.writeFileSync(`${prefix}.pid`, `${process.pid}\n`, { flag: "wx" });
const emit = (value: unknown) => {
  fs.appendFileSync(`${prefix}.jsonl`, `${JSON.stringify(value)}\n`);
};
const extension = path.join(
  output,
  process.platform === "darwin" ? "bufprobe.dylib" : "bufprobe.so",
);
const counters = z.object({
  reads: z.number(),
  read_bytes: z.number(),
  writes: z.number(),
  write_bytes: z.number(),
  page_reads: z.number(),
  small_reads: z.number(),
});
const ioSchema = z.object({
  cache_hits: z.number(),
  cache_misses: z.number(),
  main: counters,
  wal: counters,
  journal: counters,
  other: counters,
  physical: z.object({ read_bytes: z.number(), write_bytes: z.number() }).optional(),
});
const records: unknown[] = [];
using control = new DatabaseSync(":memory:", { allowExtension: true });
control.loadExtension(extension, "sqlite3_bufprobe_init");
using db = openNodeSqliteDatabase(fixture, { allowExtension: true });
db.loadExtension(extension, "sqlite3_bufprobe_init");
admitSqliteSchema(db);
enableNodeSqliteKyselyStatementCache(db);
registerOpenClawAgentDatabaseIdentity(db);
const maintenance = configureSqliteWalMaintenance(db, { databasePath: fixture });
db.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048; PRAGMA busy_timeout=0");
const database = { agentId: "main", path: fixture, db, walMaintenance: maintenance };
const identity = readOpenClawAgentDatabaseIdentity(database);
const target = {
  sessionKey: `agent:main:${values.session}`,
  database: {
    kind: "file" as const,
    physicalIdentity: identity.identity,
    birthtime: identity.birthtime,
    nativeLocation: fixture,
  },
};
const readIo = (connection = db) =>
  ioSchema.parse(JSON.parse(String(connection.prepare("SELECT buf696_io() AS io").get()?.io)));
const reset = (connection = db) => connection.prepare("SELECT buf696_reset()").get();
function ioDelta(before: ReturnType<typeof readIo>, after: ReturnType<typeof readIo>) {
  const difference = (left: z.infer<typeof counters>, right: z.infer<typeof counters>) => ({
    reads: right.reads - left.reads,
    read_bytes: right.read_bytes - left.read_bytes,
    writes: right.writes - left.writes,
    write_bytes: right.write_bytes - left.write_bytes,
    page_reads: right.page_reads - left.page_reads,
    small_reads: right.small_reads - left.small_reads,
  });
  return {
    ...after,
    cache_hits: after.cache_hits - before.cache_hits,
    cache_misses: after.cache_misses - before.cache_misses,
    main: difference(before.main, after.main),
    wal: difference(before.wal, after.wal),
    journal: difference(before.journal, after.journal),
    other: difference(before.other, after.other),
  };
}
const walBytes = () => (fs.existsSync(`${fixture}-wal`) ? fs.statSync(`${fixture}-wal`).size : 0);
const memory = () => {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  return { rss, heapUsed, heapTotal };
};
function measure<T>(label: string, invoke: () => T, resetCounters = true, connection = db) {
  connection.exec("PRAGMA shrink_memory");
  if (resetCounters) {
    reset(connection);
  }
  const beforeIo = readIo(connection);
  const physical = beforeIo.physical;
  const cpu = process.cpuUsage();
  const start = performance.now();
  const value = invoke();
  const wallMs = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  const io = ioDelta(beforeIo, readIo(connection));
  const record = {
    label,
    wallMs,
    cpuMs: (usage.user + usage.system) / 1000,
    io,
    physicalReadBytes:
      physical && io.physical ? io.physical.read_bytes - physical.read_bytes : null,
    physicalWriteBytes:
      physical && io.physical ? io.physical.write_bytes - physical.write_bytes : null,
    walBytes: walBytes(),
    memory: memory(),
    hostLoad: os.loadavg(),
  };
  records.push(record);
  emit(record);
  return { value, record };
}
function hydrate(opened = database) {
  opened.db.exec("BEGIN");
  try {
    return hydrateSessionActorState(
      opened,
      target,
      { epoch: "synthetic", sequence: 0 },
      "synthetic",
    );
  } finally {
    opened.db.exec("ROLLBACK");
  }
}
function openFreshReader() {
  const reader = openNodeSqliteDatabase(fixture, { readOnly: true, allowExtension: true });
  reader.loadExtension(extension, "sqlite3_bufprobe_init");
  admitSqliteSchema(reader);
  enableNodeSqliteKyselyStatementCache(reader);
  registerOpenClawAgentDatabaseIdentity(reader);
  reader.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048");
  return reader;
}

async function compareColdHydration() {
  const saved = db
    .prepare(
      "SELECT seq,serialized_bytes,dependency_navigation_json FROM session_transcript_active_event_facts WHERE session_id=? ORDER BY seq",
    )
    .all(values.session);
  const active = db
    .prepare(
      "SELECT active_event_count AS n FROM session_transcript_index_state WHERE session_id=?",
    )
    .get(values.session)?.n;
  assert.equal(
    saved.length,
    Number(active),
    "Complete selected-session coverage is required before comparison",
  );
  assert(baselineTailRows < saved.length, "Baseline must leave historical coverage missing");
  const baselineLabel = baselineTailRows === 0 ? "cold-empty" : "cold-partial";
  const baselineSequences = new Set(
    db
      .prepare(
        "SELECT event_seq FROM session_transcript_active_events WHERE session_id=? ORDER BY active_position DESC LIMIT ?",
      )
      .all(values.session, baselineTailRows)
      .map((row) => row.event_seq),
  );
  const baselineFacts = saved.filter((row) => baselineSequences.has(row.seq));
  assert.equal(baselineFacts.length, baselineTailRows);
  const insert = db.prepare("INSERT INTO session_transcript_active_event_facts VALUES(?,?,?,?)");
  const populate = (full: boolean) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM session_transcript_active_event_facts WHERE session_id=?").run(
        values.session,
      );
      for (const row of full ? saved : baselineFacts) {
        assert(
          row.seq !== undefined &&
            row.serialized_bytes !== undefined &&
            row.dependency_navigation_json !== undefined,
        );
        insert.run(values.session, row.seq, row.serialized_bytes, row.dependency_navigation_json);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  };
  let expected: ReturnType<typeof hydrate> | undefined;
  const run = (label: string) => {
    using reader = openFreshReader();
    const result = measure(label, () => hydrate({ ...database, db: reader }), true, reader);
    if (expected) {
      assert(
        isDeepStrictEqual(expected, result.value),
        "Fresh-reader hydration changed with coverage",
      );
    } else {
      expected = result.value;
    }
  };
  try {
    populate(false);
    for (let pair = 0; pair < 4; pair++) {
      assert(os.loadavg()[0]! <= 40, "Host load above40 before fresh-reader control pair");
      run("cold-control-a");
      run("cold-control-b");
    }
    for (let pair = 0; pair < 5; pair++) {
      assert(os.loadavg()[0]! <= 40, "Host load above40 before fresh-reader comparison pair");
      for (const full of pair % 2 ? [true, false] : [false, true]) {
        populate(full);
        run(full ? "cold-full" : baselineLabel);
      }
    }
    if (allocationIterations > 0) {
      for (let pair = 0; pair < 2; pair++) {
        assert(os.loadavg()[0]! <= 40, "Host load above40 before fresh-reader allocation pair");
        for (const full of pair % 2 ? [true, false] : [false, true]) {
          populate(full);
          const inspector = new Session();
          await startCollectedHeapSampling(inspector, 32768);
          const start = performance.now();
          const cpu = process.cpuUsage();
          try {
            for (let index = 0; index < allocationIterations; index++) {
              using reader = openFreshReader();
              const value = hydrate({ ...database, db: reader });
              assert(isDeepStrictEqual(expected, value));
            }
            const usage = process.cpuUsage(cpu);
            const { profile } = await inspector.post("HeapProfiler.stopSampling");
            const record = {
              label: full ? "cold-full-allocation" : `${baselineLabel}-allocation`,
              pair,
              scope: "Fresh-reader open, admission, hydration, equality, and close",
              iterations: allocationIterations,
              allocationBytes: sumSampledHeapBytes(profile.head),
              cpuMs: (usage.user + usage.system) / 1000,
              wallMs: performance.now() - start,
              hostLoad: os.loadavg(),
            };
            records.push(record);
            emit(record);
          } finally {
            inspector.disconnect();
          }
        }
      }
    }
  } finally {
    populate(true);
  }
  fs.writeFileSync(
    `${prefix}.json`,
    `${JSON.stringify(
      {
        scope:
          "Fresh native reader per hydration; identical current source with baseline/full synthetic facts",
        baseline: {
          coverage: baselineTailRows === 0 ? "empty" : "partial",
          facts: baselineFacts.length,
          activeRows: Number(active),
        },
        fixture,
        fixtureRows: fixtureReport.rows,
        session: values.session,
        sqliteCache: "Fresh2MiB native cache per sample; OS cache uncontrolled",
        coverageRestored: true,
        equivalent: true,
        records,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({ report: `${prefix}.json`, coverageRestored: true, equivalent: true }),
  );
}
async function sampleHydration(label: string) {
  if (allocationIterations === 0) {
    return;
  }
  const inspector = new Session();
  await startCollectedHeapSampling(inspector, 32768);
  const start = performance.now();
  const cpu = process.cpuUsage();
  try {
    for (let index = 0; index < allocationIterations; index++) {
      db.exec("PRAGMA shrink_memory");
      hydrate();
    }
    const usage = process.cpuUsage(cpu);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const record = {
      label,
      iterations: allocationIterations,
      allocationBytes: sumSampledHeapBytes(profile.head),
      cpuMs: (usage.user + usage.system) / 1000,
      wallMs: performance.now() - start,
      hostLoad: os.loadavg(),
    };
    records.push(record);
    emit(record);
  } finally {
    inspector.disconnect();
  }
}
try {
  assert(os.loadavg()[0]! <= 40, "Host load above40: do not begin a measured arm");
  if (values["compare-hydration"]) {
    await compareColdHydration();
  } else {
    const initialFacts = db
      .prepare("SELECT count(*) AS n FROM session_transcript_active_event_facts WHERE session_id=?")
      .get(values.session)?.n;
    for (let round = 0; round < 5; round++) {
      const discovered = measure("discovery", () =>
        discoverTranscriptActiveFactsBackfillSessions(db),
      );
      emit({
        label: "priority",
        sessions: discovered.value.length,
        first: discovered.value.slice(0, 4),
      });
    }
    let before: ReturnType<typeof hydrate> | undefined;
    if (!values["skip-hydration"]) {
      for (let round = 0; round < 5; round++) {
        before = measure("hydration-before", hydrate).value;
      }
      await sampleHydration("hydration-before-allocation");
    }
    let cursor = startPosition - 1;
    let completed = false;
    let rowsFilled = 0;
    let rowsVisited = 0;
    let bytesRead = 0;
    const batches = [];
    const campaignStart = performance.now();
    const campaignCpu = process.cpuUsage();
    reset();
    const ioStart = readIo();
    const physicalStart = ioStart.physical;
    const batchLimit = values["skip-backfill"] ? 0 : maxBatches || Infinity;
    for (let index = 0; index < batchLimit; index++) {
      const batch = measure(
        "batch",
        () => {
          db.exec("BEGIN IMMEDIATE");
          try {
            const value = backfillTranscriptActiveFactsBatchInTransaction(db, {
              sessionId: values.session,
              afterPosition: cursor,
            });
            db.exec("COMMIT");
            return value;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
        false,
      );
      const nextDelayMs = Math.max(pauseMs, dutyRatio * batch.record.wallMs);
      batches.push({ ...batch.record, result: batch.value, nextDelayMs });
      emit({ label: "batch-result", index, ...batch.value });
      rowsFilled += batch.value.rowsFilled;
      rowsVisited += batch.value.rowsVisited;
      bytesRead += batch.value.bytesRead;
      cursor = batch.value.afterPosition;
      if (batch.value.done) {
        completed = true;
        break;
      }
      await pause(nextDelayMs);
    }
    const usage = process.cpuUsage(campaignCpu);
    const campaignIo = ioDelta(ioStart, readIo());
    const physicalEnd = campaignIo.physical;
    const campaign = {
      completed,
      skipped: values["skip-backfill"],
      initialFacts,
      rowsFilled,
      rowsVisited,
      bytesRead,
      pauseMs,
      dutyRatio,
      startPosition,
      pacingScope:
        "Native BEGIN-through-COMMIT elapsed model; host returned delays are measured separately",
      io: campaignIo,
      wallMs: performance.now() - campaignStart,
      cpuMs: (usage.user + usage.system) / 1000,
      physicalReadBytes:
        physicalStart && physicalEnd ? physicalEnd.read_bytes - physicalStart.read_bytes : null,
      physicalWriteBytes:
        physicalStart && physicalEnd ? physicalEnd.write_bytes - physicalStart.write_bytes : null,
      walBytes: walBytes(),
      checkpointHealth: maintenance.health,
      memory: memory(),
      hostLoad: os.loadavg(),
    };
    if (!values["skip-hydration"]) {
      for (let round = 0; round < 5; round++) {
        assert(
          isDeepStrictEqual(before, measure("hydration-after", hydrate).value),
          "Hydration changed after filling facts",
        );
      }
      await sampleHydration("hydration-after-allocation");
    }
    const closeIoBefore = readIo();
    const closeStart = performance.now();
    await maintenance.stop();
    maintenance.close();
    const closeMs = performance.now() - closeStart;
    const closeIo = ioDelta(closeIoBefore, readIo());
    const report = {
      scope:
        "Native production owners; not Gateway scheduling, foreground admission, or shutdown proof",
      fixture,
      fixtureRows: fixtureReport.rows,
      session: values.session,
      sqliteCache: "2MiB; released before every measured operation; OS cache uncontrolled",
      campaign,
      closeMs,
      closeIo,
      walBytesAfterClose: walBytes(),
      records,
      batches,
    };
    fs.writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ report: `${prefix}.json`, campaign, closeMs }));
  }
} finally {
  await maintenance.stop();
  maintenance.close();
  control.prepare("SELECT buf696_restore()").get();
}
