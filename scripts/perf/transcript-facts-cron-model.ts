/**
 * Real same-session cron-model opens on synthetic, writer-created compacted history.
 * See transcript-facts-cron-model.md. No production state or model calls are used.
 * node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-cron-model.ts \
 *   --output .local/facts-cron --shape frv --mode prepare
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { z } from "zod";
import { sessionManagerOpenTranscriptCohort } from "../../src/agents/sessions/session-manager-core.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    shape: { type: "string", default: "frv" },
    mode: { type: "string", default: "prepare" },
    phase: { type: "string", default: "all" },
    samples: { type: "string", default: "5" },
    smoke: { type: "boolean", default: false },
    "ordinary-history": { type: "boolean", default: false },
    "open-path": { type: "string", default: "cohort" },
  },
});
assert(values.output, "--output is required");
assert(values.shape === "frv" || values.shape === "shellbench");
assert(["prepare", "backfill", "measure", "inspect"].includes(values.mode));
assert(["before", "after", "natural", "all"].includes(values.phase));
assert(values["open-path"] === "cohort" || values["open-path"] === "simple");
const output = path.resolve(values.output);
assert(output.startsWith("/Volumes/SF1-Storage/"), "Synthetic databases must stay on SF1");
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
const shape = values.smoke
  ? { rows: 2001, compactions: 3, tailRows: 25, utf8Bytes: 20_000_000, tailBytes: 250_000 }
  : values.shape === "frv"
    ? { rows: 48_111, compactions: 15, tailRows: 725, utf8Bytes: 626_000_000, tailBytes: 9_200_000 }
    : {
        rows: 13_971,
        compactions: 18,
        tailRows: 180,
        utf8Bytes: 137_000_000,
        tailBytes: 1_800_000,
      };
const stem = `${values.shape}${values.smoke ? "-smoke" : ""}${values["ordinary-history"] ? "-ordinary" : ""}`;
const file = (phase: string) => path.join(output, `${stem}-${phase}.sqlite`);
const write = (name: string, value: unknown) =>
  fs.writeFileSync(
    path.join(output, `${stem}-${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
const emit = (value: unknown) => console.log(JSON.stringify(value));
const extension = path.join(output, "bufprobe.dylib");
const ioCounters = z.object({ reads: z.number(), read_bytes: z.number(), page_reads: z.number() });
const ioSchema = z.object({
  main: ioCounters,
  wal: ioCounters,
  journal: ioCounters,
  other: ioCounters,
  physical: z.object({ read_bytes: z.number(), write_bytes: z.number() }).optional(),
});
const loadGate = () => {
  const load = os.loadavg();
  assert(load[0] !== undefined && load[0] <= 40, `Host load gate refused ${load.join(",")}`);
  return load;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const target = (storePath: string) => ({
  agentId: "main",
  sessionId: `synthetic-cron-${stem}`,
  sessionKey: `agent:main:synthetic-cron-${stem}`,
  storePath,
});
const { createOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const { resolveEmbeddedSessionContextLimits } =
  await import("../../src/agents/embedded-agent-runner/run/session-context-limits.js");
const { withSessionTranscriptHydrationCaller } =
  await import("../../src/config/sessions/session-transcript-hydration-caller.js");
const { closeOpenClawAgentDatabaseByPathAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const state = await createOpenClawTestState({ label: "facts-cron-model" });
const limits = resolveEmbeddedSessionContextLimits({});
try {
  if (values.mode === "prepare") {
    assert(!fs.existsSync(file("natural")), "Refusing to replace an existing fixture");
    const { upsertSessionEntryCore, persistSessionTranscriptTurn } =
      await import("../../src/config/sessions/session-accessor.js");
    const { waitForSessionTranscriptProjection } =
      await import("../../src/config/sessions/session-transcript-reconcile.js");
    const selected = target(file("natural"));
    await upsertSessionEntryCore(selected, {
      sessionId: selected.sessionId,
      updatedAt: Date.now(),
    });
    const messages = shape.rows - shape.compactions - 1;
    const retained = 8;
    const finalAppends = shape.tailRows - retained;
    const beforeLast = messages - finalAppends;
    const tailPayloadBytes = Math.floor(shape.tailBytes / shape.tailRows) - 230;
    const oldPayloadBytes =
      Math.floor((shape.utf8Bytes - shape.tailBytes) / (messages - shape.tailRows)) - 230;
    const cipher = createCipheriv("aes-256-ctr", Buffer.alloc(32, 7), Buffer.alloc(16, 3));
    const payload = (bytes: number) => {
      const random = cipher.update(Buffer.alloc(Math.floor(bytes / 3))).toString("base64");
      return `${random}${" synthetic dashboard output ".repeat(Math.ceil(bytes / 28))}`.slice(
        0,
        bytes,
      );
    };
    let written = 0;
    const started = performance.now();
    const cpu = process.cpuUsage();
    for (let compact = 1; compact <= shape.compactions + 1; compact++) {
      const end =
        compact <= shape.compactions
          ? Math.floor((beforeLast * compact) / shape.compactions)
          : messages;
      while (written < end) {
        const count = Math.min(128, end - written);
        await persistSessionTranscriptTurn(selected, {
          expectedSessionId: selected.sessionId,
          touchSessionEntry: false,
          messages: Array.from({ length: count }, (_, offset) => {
            const index = written + offset;
            const text = payload(
              index >= beforeLast - retained ? tailPayloadBytes : oldPayloadBytes,
            );
            const excluded =
              !values["ordinary-history"] && index < beforeLast - retained && index % 2 === 1;
            return {
              eventId: `synthetic-message-${index}`,
              message: {
                role: excluded ? "assistant" : "user",
                content: text,
                ...(excluded ? { excludeFromContext: true } : {}),
                timestamp: index + 1,
              },
              now: index + 1,
            };
          }),
        });
        written += count;
      }
      if (compact <= shape.compactions) {
        const manager = await SessionManager.openAsync(selected, state.workspaceDir, {
          maxBytes: 512_000,
          maxEvents: 32,
        });
        await manager.appendCompactionAsync(
          `Synthetic dashboard compaction ${compact}: earlier work summarized.`,
          `synthetic-message-${written - retained}`,
          written * 100,
        );
      }
      emit({
        phase: "prepare",
        compact,
        written,
        wallMs: performance.now() - started,
        load: os.loadavg(),
      });
    }
    await waitForSessionTranscriptProjection(selected);
    await closeOpenClawAgentDatabaseByPathAsync(selected.storePath);
    using db = new DatabaseSync(file("natural"));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const metadata = db
      .prepare(`SELECT count(*) rows, sum(event_utf8_bytes) utf8Bytes,
      sum(length(event_zstd)) zstdBytes FROM transcript_events WHERE session_id = ?`)
      .get(selected.sessionId);
    const active = db
      .prepare(`SELECT count(*) rows, sum(context_eligible) eligible
      FROM session_transcript_active_events WHERE session_id = ?`)
      .get(selected.sessionId);
    const facts = db
      .prepare(
        `SELECT count(*) rows FROM session_transcript_active_event_facts WHERE session_id = ?`,
      )
      .get(selected.sessionId);
    const boundaries = db
      .prepare(`SELECT count(*) count FROM transcript_event_identities
      WHERE session_id = ? AND event_type = 'compaction'`)
      .get(selected.sessionId);
    const tail = db
      .prepare(`SELECT count(*) rows, sum(facts.serialized_bytes) bytes
      FROM session_transcript_active_events AS active
      JOIN session_transcript_active_event_facts AS facts ON facts.session_id=active.session_id AND facts.seq=active.event_seq
      WHERE active.session_id=? AND active.event_seq >= (SELECT seq FROM transcript_event_identities
        WHERE session_id=? AND event_id=?)`)
      .get(selected.sessionId, selected.sessionId, `synthetic-message-${beforeLast - retained}`);
    const excluded = db
      .prepare(`SELECT count(*) rows, sum(facts.serialized_bytes) bytes
      FROM session_transcript_active_events AS active
      JOIN session_transcript_active_event_facts AS facts ON facts.session_id=active.session_id AND facts.seq=active.event_seq
      WHERE active.session_id=? AND active.context_eligible=0`)
      .get(selected.sessionId);
    const used = process.cpuUsage(cpu);
    const manifest = {
      shape,
      metadata,
      active,
      facts,
      boundaries,
      tail,
      excluded,
      limits,
      databaseBytes: fs.statSync(file("natural")).size,
      wallMs: performance.now() - started,
      cpuMs: (used.user + used.system) / 1000,
      stateRoot: state.root,
    };
    write("fixture", manifest);
    emit(manifest);
    db.close();
    fs.copyFileSync(
      file("natural"),
      file("before"),
      fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
    );
    using legacy = new DatabaseSync(file("before"));
    legacy
      .prepare(`DELETE FROM session_transcript_active_event_facts WHERE session_id=?
      AND seq NOT IN (SELECT event_seq FROM session_transcript_active_events WHERE session_id=? ORDER BY active_position DESC LIMIT 512)`)
      .run(selected.sessionId, selected.sessionId);
    legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    legacy.close();
    fs.copyFileSync(
      file("before"),
      file("after"),
      fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
    );
  } else if (values.mode === "backfill") {
    loadGate();
    const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
    const { admitSqliteSchema } = await import("../../src/infra/sqlite-schema-facts.js");
    const { enableNodeSqliteKyselyStatementCache } = await import("../../src/infra/kysely-sync.js");
    const { runSqliteImmediateTransactionSync } =
      await import("../../src/infra/sqlite-transaction.js");
    const { backfillTranscriptActiveFactsBatchInTransaction } =
      await import("../../src/config/sessions/session-transcript-active-facts-backfill.worker.js");
    using db = openNodeSqliteDatabase(file("after"));
    admitSqliteSchema(db);
    enableNodeSqliteKyselyStatementCache(db);
    const cursor = { sessionId: target(file("after")).sessionId, afterPosition: -1 };
    let batches = 0;
    let filled = 0;
    let skipped = 0;
    const started = performance.now();
    for (;;) {
      const result = runSqliteImmediateTransactionSync(db, () =>
        backfillTranscriptActiveFactsBatchInTransaction(db, cursor),
      );
      batches++;
      filled += result.rowsFilled;
      skipped += result.rowsSkipped;
      cursor.afterPosition = result.afterPosition;
      if (result.done || result.unavailable) {
        break;
      }
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const facts = (database: DatabaseSync) =>
      database
        .prepare(`SELECT seq, serialized_bytes, dependency_navigation_json
      FROM session_transcript_active_event_facts WHERE session_id=? ORDER BY seq`)
        .all(cursor.sessionId);
    using natural = new DatabaseSync(file("natural"), { readOnly: true });
    const afterFacts = facts(db);
    const naturalFacts = facts(natural);
    assert.deepEqual(afterFacts, naturalFacts, "Backfilled facts differ from natural writer facts");
    write("backfill", {
      batches,
      filled,
      skipped,
      wallMs: performance.now() - started,
      factsCount: afterFacts.length,
      factsDigest: digest(afterFacts),
      naturalFactsDigest: digest(naturalFacts),
    });
  } else if (values.mode === "inspect") {
    loadGate();
    const selected = target(file("after"));
    const manager = await withSessionTranscriptHydrationCaller("cron-model", () =>
      SessionManager[sessionManagerOpenTranscriptCohort](
        selected,
        { ...limits, cwd: state.workspaceDir },
        { sessionKey: selected.sessionKey, entryIds: [], includeMessagePresence: true },
        () => {},
      ),
    );
    const entries = manager.getEntries();
    const context = manager.buildSessionContext();
    const measured = z
      .object({
        results: z.array(z.object({ entriesDigest: z.string(), modelMessagesDigest: z.string() })),
      })
      .parse(
        JSON.parse(fs.readFileSync(path.join(output, `${stem}-measure-cohort-all.json`), "utf8")),
      );
    assert(
      measured.results.every(
        (row) =>
          row.entriesDigest === digest(entries) &&
          row.modelMessagesDigest === digest(context.messages),
      ),
    );
    await closeOpenClawAgentDatabaseByPathAsync(selected.storePath);
    using db = new DatabaseSync(selected.storePath, { readOnly: true });
    const rows = entries.map((entry) => {
      const row = db
        .prepare(`SELECT identity.seq, identity.event_type, facts.serialized_bytes
        FROM transcript_event_identities AS identity
        LEFT JOIN session_transcript_active_event_facts AS facts ON facts.session_id=identity.session_id AND facts.seq=identity.seq
        WHERE identity.session_id=? AND identity.event_id=?`)
        .get(selected.sessionId, entry.id);
      assert(row, `Missing selected identity ${entry.id}`);
      return { id: entry.id, ...row };
    });
    const coverage = db
      .prepare(`SELECT count(*) activeRows,
      sum(active.context_eligible=0) excludedRows, sum(facts.seq IS NULL) missingFacts
      FROM session_transcript_active_events AS active
      LEFT JOIN session_transcript_active_event_facts AS facts ON facts.session_id=active.session_id AND facts.seq=active.event_seq
      WHERE active.session_id=?`)
      .get(selected.sessionId);
    const types = db
      .prepare(
        `SELECT event_type, count(*) rows FROM transcript_event_identities WHERE session_id=? GROUP BY event_type`,
      )
      .all(selected.sessionId);
    const offPath = db
      .prepare(`SELECT count(*) rows FROM transcript_event_identities AS identity
      LEFT JOIN session_transcript_active_events AS active ON active.session_id=identity.session_id AND active.event_seq=identity.seq
      WHERE identity.session_id=? AND identity.event_type!='session' AND active.event_seq IS NULL`)
      .get(selected.sessionId);
    const pending = db
      .prepare(`SELECT count(*) rows FROM session_transcript_active_event_facts WHERE session_id=?
      AND json_extract(dependency_navigation_json, '$.message.openclawModelPlacement')='pending'`)
      .get(selected.sessionId);
    const cold = db
      .prepare("SELECT count(*) rows FROM session_transcript_cold_archives WHERE session_id=?")
      .get(selected.sessionId);
    const projection = db
      .prepare("SELECT * FROM session_transcript_index_state WHERE session_id=?")
      .get(selected.sessionId);
    const metadataFootprint = db
      .prepare(`SELECT name, count(*) pages, sum(pgsize) bytes FROM dbstat
      WHERE name IN (SELECT name FROM sqlite_schema WHERE tbl_name IN
        ('session_transcript_active_events','session_transcript_active_event_facts','transcript_event_identities','session_transcript_index_state'))
      GROUP BY name`)
      .all();
    write("inspection", {
      coverage,
      types,
      offPath,
      pending,
      cold,
      projection,
      metadataFootprint,
      header: manager.getHeader(),
      selectedRows: rows,
      entriesDigest: digest(entries),
      modelMessages: context.messages.length,
      modelMessagesDigest: digest(context.messages),
      note: "Metadata object sizes are storage footprints, not measured per-object IO. Selected payload IDs come from the real cohort open; the stored header is additional.",
    });
  } else {
    const phases = values.phase === "all" ? ["before", "after", "natural"] : [values.phase];
    assert(
      phases.every((phase) => fs.existsSync(file(phase))),
      "Prepare the fixture first",
    );
    if (!fs.existsSync(extension)) {
      execFileSync(
        "clang",
        [
          "-O2",
          "-Wall",
          "-Wextra",
          "-dynamiclib",
          "-I/opt/homebrew/opt/sqlite/include",
          "scripts/perf/transcript-active-facts-vfs.c",
          "-o",
          extension,
        ],
        { stdio: "inherit" },
      );
    }
    using control = new DatabaseSync(":memory:", { allowExtension: true });
    control.loadExtension(extension, "sqlite3_bufprobe_init");
    const io = () =>
      ioSchema.parse(JSON.parse(String(control.prepare("SELECT buf696_io() io").get()?.io)));
    const countFacts = (storePath: string) => {
      using database = new DatabaseSync(storePath, { readOnly: true });
      return Number(
        database
          .prepare(
            "SELECT count(*) count FROM session_transcript_active_event_facts WHERE session_id=?",
          )
          .get(target(storePath).sessionId)?.count,
      );
    };
    const counts = new Map(phases.map((phase) => [phase, countFacts(file(phase))]));
    if (phases.includes("before")) {
      assert.equal(counts.get("before"), 512);
    }
    const results = [];
    try {
      for (let sample = 0; sample < samples; sample++) {
        for (const phase of sample % 2 === 0 ? phases : phases.toReversed()) {
          const selected = target(file(phase));
          await closeOpenClawAgentDatabaseByPathAsync(selected.storePath);
          control.prepare("SELECT buf696_target(?, 1)").get(selected.storePath);
          const load = loadGate();
          control.prepare("SELECT buf696_reset()").get();
          const physicalBefore = io().physical;
          const cpu = process.cpuUsage();
          const started = performance.now();
          const manager = await withSessionTranscriptHydrationCaller("cron-model", () =>
            values["open-path"] === "simple"
              ? SessionManager.openAsync(selected, state.workspaceDir, limits)
              : SessionManager[sessionManagerOpenTranscriptCohort](
                  selected,
                  { ...limits, cwd: state.workspaceDir },
                  { sessionKey: selected.sessionKey, entryIds: [], includeMessagePresence: true },
                  (_manager, prepared) => {
                    assert.equal(prepared.kind, "bounded");
                  },
                ),
          );
          const wallMs = performance.now() - started;
          const used = process.cpuUsage(cpu);
          const reads = io();
          const entries = manager.getEntries();
          const context = manager.buildSessionContext();
          const result = {
            phase,
            sample,
            load,
            loadAfter: os.loadavg(),
            wallMs,
            cpuMs: (used.user + used.system) / 1000,
            entries: entries.length,
            hydratedEvents: entries.length + Number(Boolean(manager.getHeader())),
            modelMessages: context.messages.length,
            modelMessagesDigest: digest(context.messages),
            factsCount: countFacts(selected.storePath),
            entriesBytes: Buffer.byteLength(JSON.stringify(entries)),
            entriesDigest: digest(entries),
            io: reads,
            physicalReadBytes:
              reads.physical && physicalBefore
                ? reads.physical.read_bytes - physicalBefore.read_bytes
                : null,
            vfsBytes:
              reads.main.read_bytes +
              reads.wal.read_bytes +
              reads.journal.read_bytes +
              reads.other.read_bytes,
            readSpans: reads.main.reads + reads.wal.reads + reads.journal.reads + reads.other.reads,
          };
          assert.equal(
            result.factsCount,
            counts.get(phase),
            "Open unexpectedly changed fact coverage",
          );
          assert(result.readSpans > 0, "VFS instrumentation did not observe the real worker open");
          results.push(result);
          emit(result);
          await closeOpenClawAgentDatabaseByPathAsync(selected.storePath);
        }
      }
      const first = results[0];
      assert(results.every((row) => row.entriesDigest === first?.entriesDigest));
      assert(results.every((row) => row.modelMessagesDigest === first?.modelMessagesDigest));
      write(`measure-${values["open-path"]}-${values.phase}`, {
        shape,
        limits,
        openPath: values["open-path"],
        node: process.version,
        probeSha256: createHash("sha256").update(fs.readFileSync(extension)).digest("hex"),
        scriptSha256: createHash("sha256")
          .update(fs.readFileSync(new URL(import.meta.url)))
          .digest("hex"),
        results,
      });
    } finally {
      control.prepare("SELECT buf696_restore()").get();
      for (const phase of phases) {
        await closeOpenClawAgentDatabaseByPathAsync(file(phase));
      }
    }
  }
} finally {
  await state.cleanup();
}
