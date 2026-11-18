/**
 * Synthetic cold-storage owner and serving-maintenance proof; never uses operator state.
 * Prepare identical closed fixtures with --prepare --state-dir <new-dir> [--sessions 4 --events 1500].
 * Default fixture: 50,000 events / 220,291,661 raw UTF-8 bytes, qualified navigation and full FTS.
 * Run against a fresh copy: --state-dir <copy> [--source-root <baseline-checkout>] [--sweep].
 * --sweep selects the candidate's deferred cleanup; baseline has no sweep operation.
 * --profile records native SQL, zstd and iterator costs separately from uninstrumented timings.
 * --flow uses actual maintenance and concurrent transcript appends, with the companion observer preloaded:
 * NODE_OPTIONS=--import=./scripts/perf/session-cold-writer-observer.mjs node --import ./scripts/tsx.mjs \
 *   scripts/perf/session-cold-writer.mjs --state-dir <copy> --flow
 * Imports, fixture generation, pre/post digests and close are outside measured owner timings.
 * Archive elapsed includes preparation + publication + all cleanup sweeps; restore remains one transaction.
 * Holds include COMMIT, exclude BEGIN wait. Native profile timings include instrumentation overhead.
 * Set OPENCLAW_COLD_WRITER_PROFILE_DIR to an existing directory for sampled allocations
 * (including collected objects) and CPU profiles, flushed before worker teardown.
 * Run >=5 alternating baseline/candidate fresh processes serially; retain host load and all samples.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { channel as diagnosticChannel } from "node:diagnostics_channel";
import fs from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { BroadcastChannel } from "node:worker_threads";
import zlib from "node:zlib";
import { InsertQueryBuilder } from "kysely";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "source-root": { type: "string", default: process.cwd() },
    prepare: { type: "boolean" },
    sweep: { type: "boolean" },
    profile: { type: "boolean" },
    flow: { type: "boolean" },
    "restore-flow": { type: "boolean" },
    appends: { type: "string", default: "200" },
    events: { type: "string", default: "50000" },
    sessions: { type: "string", default: "1" },
  },
});
assert(values["state-dir"], "--state-dir is required");
const root = path.resolve(values["state-dir"]);
const source = path.resolve(values["source-root"]);
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = path.join(root, "home");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
const load = (relative) => import(pathToFileURL(path.join(source, relative)).href);
const agent = await load("src/state/openclaw-agent-db.ts");
const state = await load("src/state/openclaw-state-db.ts");
const entry = await load("src/config/sessions/session-accessor.sqlite-entry.ts");
const { writeSessionColdRecordsInTransaction } = await load(
  "src/config/sessions/session-cold-storage-records.ts",
);
const { prepareSessionColdBatchInWorker } = await load(
  "src/config/sessions/session-cold-storage-prepare.ts",
);
const { readSessionColdTranscript } = await load(
  "src/config/sessions/session-cold-storage-state.ts",
);
const { readTranscriptPayload } = await load("src/config/sessions/transcript-payload.ts");
const owner = { ...(await load("src/config/sessions/session-cold-storage-worker.ts")) };
if (fs.existsSync(path.join(source, "src/config/sessions/session-cold-storage-restore.ts"))) {
  Object.assign(owner, await load("src/config/sessions/session-cold-storage-restore.ts"));
}
const options = { agentId: "main", path: path.join(root, "agent.sqlite") };
const manifestPath = path.join(root, "fixture.json");
const environment = () => ({
  cpu: cpus()[0].model,
  ramBytes: totalmem(),
  node: process.version,
  load: loadavg(),
});

async function prepare() {
  fs.mkdirSync(root, { recursive: true });
  assert(!fs.existsSync(options.path), "Prepare requires a new database");
  fs.writeFileSync(
    process.env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({ agents: { entries: { main: { workspace: path.join(root, "workspace") } } } }),
  );
  const count = Number(values.events),
    sessions = Number(values.sessions);
  assert(
    Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(sessions) && sessions > 0,
  );
  let rawBytes = 0;
  for (let session = 0; session < sessions; session++) {
    const sessionId = `synthetic-${session}`;
    entry.replaceSessionEntrySync(
      { agentId: "main", storePath: options.path, sessionKey: `agent:main:${sessionId}` },
      { sessionId, updatedAt: 1 },
    );
    for (let first = 0; first < count; first += 512) {
      const events = [],
        identities = [],
        active = [],
        fts = [];
      for (let seq = first; seq < Math.min(count, first + 512); seq++) {
        const text = `Synthetic event ${seq}. ` + "bounded storage sample ".repeat(185);
        const role = seq % 2 ? "assistant" : "user";
        const event = JSON.stringify({
          type: "message",
          id: `event-${seq}`,
          parentId: seq ? `event-${seq - 1}` : null,
          message: { role, content: [{ type: "text", text }] },
        });
        rawBytes += Buffer.byteLength(event);
        events.push({ kind: "event", row: { seq, event_json: event, created_at: 1 } });
        identities.push({
          kind: "identity",
          row: {
            event_id: `event-${seq}`,
            seq,
            event_type: "message",
            parent_id: seq ? `event-${seq - 1}` : null,
            message_idempotency_key: null,
            created_at: 1,
          },
        });
        active.push({
          kind: "active",
          row: { active_position: seq, event_seq: seq, message_position: seq, context_eligible: 1 },
        });
        fts.push({ kind: "fts", row: { message_id: `event-${seq}`, text, role, timestamp: 1 } });
      }
      agent.runOpenClawAgentWriteTransaction(
        (database) =>
          writeSessionColdRecordsInTransaction(
            database,
            sessionId,
            [...events, ...identities, ...active, ...fts],
            "restore",
          ),
        options,
      );
    }
    agent.runOpenClawAgentWriteTransaction(({ db }) => {
      // sqlite-allow-raw -- Synthetic fixture metadata, outside measurement.
      db.prepare(
        "INSERT INTO transcript_rewrite_watermarks(session_id,generation,updated_at) VALUES(?,?,1) ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation",
      ).run(sessionId, `generation-${session}`);
      db.prepare(
        "INSERT INTO session_transcript_index_state(session_id,indexed_seq,leaf_event_id,needs_rebuild,active_event_count,active_message_count,updated_at) VALUES(?,?,?,0,?,?,1)",
      ).run(sessionId, count - 1, `event-${count - 1}`, count, count);
      db.prepare(
        "UPDATE session_windows SET updated_at=1,transcript_updated_at=1 WHERE session_id=?",
      ).run(sessionId);
    }, options);
  }
  const manifest = { sessions, eventsPerSession: count, rawBytes };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(JSON.stringify({ prepared: manifest, environment: environment() }));
}

function digest(database, navigationOnly = false) {
  const hash = createHash("sha256");
  const consume = (row) => hash.update(JSON.stringify(row) + "\n");
  // sqlite-allow-raw -- Exact synthetic state comparison, outside measurement.
  for (const row of database
    .prepare("SELECT * FROM transcript_events ORDER BY session_id,seq")
    .iterate()) {
    const { event_json: _eventJson, event_zstd: _eventZstd, ...facts } = row;
    consume(navigationOnly ? facts : { ...facts, event_json: readTranscriptPayload(row) });
  }
  if (!navigationOnly) {
    for (const table of [
      "transcript_event_identities",
      "session_transcript_active_events",
      "session_transcript_index_state",
      "transcript_rewrite_watermarks",
      "session_windows",
      "session_nodes",
    ]) {
      for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).iterate()) {
        consume(row);
      }
    }
    for (const row of database
      .prepare(
        "SELECT session_id,message_id,text,role,timestamp FROM session_transcript_fts ORDER BY session_id,message_id",
      )
      .iterate()) {
      consume(row);
    }
  }
  return hash.digest("hex");
}

async function measureOwners() {
  const fixture = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const database = agent.openOpenClawAgentDatabase(options);
  const before = digest(database.db),
    navigation = digest(database.db, true);
  const transactions = [],
    active = new WeakMap(),
    sql = {},
    phases = {};
  const undo = [];
  const execDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
  assert(execDescriptor && typeof execDescriptor.value === "function");
  DatabaseSync.prototype.exec = function (statement) {
    const start = performance.now(),
      previous = active.get(this);
    const result = execDescriptor.value.call(this, statement);
    if (/^\s*BEGIN\b/i.test(statement) && this.location() === options.path) {
      active.set(this, { start: performance.now(), statement });
    } else if (previous && /^\s*(COMMIT|ROLLBACK)\b/i.test(statement)) {
      transactions.push({
        begin: previous.statement,
        holdMs: performance.now() - previous.start,
        commitMs: performance.now() - start,
      });
      active.delete(this);
    }
    return result;
  };
  undo.push(() => {
    Object.defineProperty(DatabaseSync.prototype, "exec", execDescriptor);
  });
  const timed = (name, run) => {
    const start = performance.now();
    try {
      return run();
    } finally {
      const bucket = (phases[name] ??= { calls: 0, ms: 0 });
      bucket.calls++;
      bucket.ms += performance.now() - start;
    }
  };
  if (values.profile) {
    const descriptor = Object.getOwnPropertyDescriptor(InsertQueryBuilder.prototype, "compile");
    assert(descriptor?.value);
    InsertQueryBuilder.prototype.compile = function () {
      const start = performance.now();
      const compiled = descriptor.value.call(this);
      const table = /insert into "([a-z_]+)"/i.exec(compiled.sql)?.[1] ?? "other";
      const bucket = (phases[`compile:${table}`] ??= { calls: 0, ms: 0 });
      bucket.calls++;
      bucket.ms += performance.now() - start;
      return compiled;
    };
    undo.push(() => {
      Object.defineProperty(InsertQueryBuilder.prototype, "compile", descriptor);
    });
    for (const method of ["get", "all", "run"]) {
      const original = StatementSync.prototype[method];
      StatementSync.prototype[method] = function (...args) {
        const text = this.sourceSQL;
        const name =
          text.includes("metadata") && text.includes("navigation_json")
            ? "navigation"
            : (/\b(?:into|from|update)\s+["`]?([a-z_]+)/i.exec(text)?.[1] ?? "other");
        const bucket = (sql[name] ??= { calls: 0, ms: 0 });
        bucket.calls++;
        const start = performance.now();
        try {
          return Reflect.apply(original, this, args);
        } finally {
          bucket.ms += performance.now() - start;
        }
      };
      undo.push(() => {
        StatementSync.prototype[method] = original;
      });
    }
    for (const name of ["zstdCompressSync", "zstdDecompressSync"]) {
      const original = zlib[name];
      zlib[name] = (...args) => timed(name, () => Reflect.apply(original, zlib, args));
      undo.push(() => {
        zlib[name] = original;
      });
    }
  }
  const host = environment();
  try {
    const start = performance.now();
    const prepared = await prepareSessionColdBatchInWorker({
      databaseOptions: options,
      admissionIdentities: [],
      liveSessionKeys: [],
      cooledSessionIds: [],
      beforeMs: 100,
      maxTranscripts: fixture.sessions,
      maxBytes: 64 * 1024 * 1024,
    });
    assert.equal(prepared.prepared.length, fixture.sessions);
    const preparationMs = performance.now() - start;
    const snapshots = transactions.splice(0);
    const flipStart = performance.now();
    const result = owner.mutateSessionColdTranscriptInWorker(
      {
        kind: "cold-batch",
        databaseOptions: options,
        prepared: prepared.prepared,
        externalizations: [],
        beforeMs: 100,
        protectionKeys: prepared.protectionKeys,
        liveSessionKeys: [],
      },
      undefined,
      () => {},
    );
    assert.equal(result.archivedTranscripts, fixture.sessions);
    const flipMs = performance.now() - flipStart;
    const flipTransactions = transactions.splice(0);
    const sweepStart = performance.now();
    const sweeps = [];
    if (values.sweep) {
      for (let session = 0; session < fixture.sessions; session++) {
        let afterSeq = -1;
        let maxRows = 256;
        while (true) {
          const { sweep } = owner.mutateSessionColdTranscriptInWorker(
            {
              kind: "cold-sweep",
              databaseOptions: options,
              sessionId: `synthetic-${session}`,
              afterSeq,
              maxRows,
            },
            undefined,
            () => {},
          );
          sweeps.push({ maxRows, ...sweep });
          if (sweep.rows === 0) {
            if (afterSeq === undefined) {
              break;
            }
            afterSeq = undefined;
          } else {
            if (afterSeq !== undefined) {
              afterSeq = sweep.afterSeq;
            }
            maxRows = Math.max(
              1,
              Math.min(256, Math.floor((sweep.rows * 20) / Math.max(1, sweep.elapsedMs))),
            );
          }
        }
      }
    }
    const sweepMs = performance.now() - sweepStart;
    const sweepTransactions = transactions.splice(0);
    assert.equal(
      digest(database.db, true),
      navigation,
      "archival changed retained navigation facts",
    );
    const archive = {
      preparationMs,
      snapshots,
      flipMs,
      flipTransactions,
      sweepMs,
      sweeps,
      sweepTransactions,
      totalMs: preparationMs + flipMs + sweepMs,
    };
    for (const key of Object.keys(phases)) {
      delete phases[key];
    }
    for (const key of Object.keys(sql)) {
      delete sql[key];
    }
    const restoreStart = performance.now();
    for (let session = 0; session < fixture.sessions; session++) {
      const sessionId = `synthetic-${session}`;
      const plan = {
        kind: "cold-restore",
        databaseOptions: options,
        sessionId,
        archive: readSessionColdTranscript(database.db, sessionId),
      };
      if (owner.restoreSessionColdTranscriptInWorker) {
        assert(
          (
            await owner.restoreSessionColdTranscriptInWorker(
              plan,
              async (run) => run(),
              () => {},
            )
          ).restored,
        );
      } else {
        const records = await owner.prepareSessionColdRestoreInWorker(plan);
        assert(owner.mutateSessionColdTranscriptInWorker(plan, records, () => {}).restored);
      }
    }
    const restore = {
      elapsedMs: performance.now() - restoreStart,
      transactions: transactions.splice(0),
      ...(values.profile ? { sql: structuredClone(sql), phases: structuredClone(phases) } : {}),
    };
    assert.equal(
      digest(database.db),
      before,
      "restoration changed exact events, navigation, metadata or search rows",
    );
    console.log(
      JSON.stringify({
        fixture,
        environment: host,
        source,
        profile: Boolean(values.profile),
        archive,
        restore,
        exactStateEqual: true,
      }),
    );
  } finally {
    for (const restore of undo.toReversed()) {
      restore();
    }
  }
}

async function measureFlow() {
  const { runSessionColdStorageMaintenance, restoreSessionColdTranscript } = await load(
    "src/config/sessions/session-cold-storage.ts",
  );
  const { acquireGatewayStateOwner } = await load("src/infra/gateway-state-owner.ts");
  const { readGatewayLockProcessNamespace } = await load("src/infra/gateway-lock-payload.ts");
  const { resolveOpenClawStateSqlitePath } = await load("src/state/openclaw-state-db.paths.ts");
  const lease = acquireGatewayStateOwner({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
    payload: {
      pid: process.pid,
      role: "gateway",
      createdAt: new Date().toISOString(),
      configPath: process.env.OPENCLAW_CONFIG_PATH,
      processNamespace: readGatewayLockProcessNamespace(),
    },
  });
  const { appendTranscriptEvent } = await load(
    "src/config/sessions/session-accessor.sqlite-transcript-write.ts",
  );
  const interactiveId = values["restore-flow"] ? "restore-interactive" : "interactive";
  const scope = {
    agentId: "main",
    storePath: options.path,
    sessionKey: `agent:main:${interactiveId}`,
    sessionId: interactiveId,
  };
  const channel = new BroadcastChannel("cold-writer-proof");
  const reservations = [];
  const reservationChannel = diagnosticChannel("openclaw.agent-database.reservation");
  const appendContext = new AsyncLocalStorage();
  const observeReservation = (record) =>
    reservations.push({ ...record, appendIndex: appendContext.getStore() });
  reservationChannel.subscribe(observeReservation);
  const sessionWriteChannel = diagnosticChannel("openclaw.session.write");
  sessionWriteChannel.subscribe(observeReservation);
  try {
    await entry.replaceSessionEntry(scope, { sessionId: interactiveId, updatedAt: Date.now() });
    await appendTranscriptEvent(scope, {
      type: "custom",
      customType: "synthetic",
      id: "warm",
      data: "warm",
    });
    reservations.length = 0;
    const transactions = [],
      closes = [],
      appends = [],
      appendLatencies = [];
    let archivalStartedAt;
    const appendCount = Number(values.appends);
    channel.addEventListener("message", ({ data }) => {
      if (data.type === "transaction") {
        transactions.push(data);
      } else if (data.type === "close") {
        closes.push(data);
      }
      if (
        data.type === (values["restore-flow"] ? "restoring" : "archiving") &&
        archivalStartedAt === undefined
      ) {
        archivalStartedAt = performance.now();
        for (let index = 0; index < appendCount; index++) {
          appends.push(
            new Promise((resolve, reject) => {
              setTimeout(
                () => {
                  const started = performance.now();
                  appendContext
                    .run(index, () =>
                      appendTranscriptEvent(scope, {
                        type: "custom",
                        customType: "synthetic",
                        id: `append-${index}`,
                        data: "synthetic append",
                      }),
                    )
                    .then((accepted) => {
                      assert(accepted);
                      appendLatencies.push(performance.now() - started);
                      resolve();
                    }, reject);
                },
                25 + index * 5,
              );
            }),
          );
        }
      }
    });
    const cpuStart = process.cpuUsage();
    const heapStart = process.memoryUsage();
    const start = performance.now();
    const result = values["restore-flow"]
      ? await restoreSessionColdTranscript({
          agentId: "main",
          storePath: options.path,
          sessionKey: "agent:main:synthetic-0",
          sessionId: "synthetic-0",
        })
      : await runSessionColdStorageMaintenance({
          config: {
            agents: { entries: { main: {} } },
            session: {
              store: options.path,
              maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
            },
          },
        });
    const finishedAt = performance.now();
    assert(
      appends.length === appendCount,
      "Run --flow with the companion observer in NODE_OPTIONS",
    );
    await Promise.all(appends);
    const cpu = process.cpuUsage(cpuStart);
    const heapAfter = process.memoryUsage();
    const profileDirectory = process.env.OPENCLAW_COLD_WRITER_PROFILE_DIR;
    const profileThreads = [...new Set([0, ...transactions.map((record) => record.threadId)])];
    if (profileDirectory) {
      await new Promise((resolve) => {
        const completed = () => {
          if (
            profileThreads.every((id) =>
              ["cpu", "allocation"].every((kind) =>
                fs.existsSync(path.join(profileDirectory, `${kind}-${process.pid}-${id}.json`)),
              ),
            )
          ) {
            channel.removeEventListener("message", completed);
            resolve();
          }
        };
        channel.addEventListener("message", completed);
        const requestProfileSnapshot = channel.postMessage.bind(channel);
        requestProfileSnapshot({ type: "profile-snapshot" });
        completed();
      });
    }
    const quantiles = (samples) => {
      const sorted = samples.toSorted((a, b) => a - b);
      return {
        count: sorted.length,
        p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
        max: sorted.at(-1),
      };
    };
    const appendReservations = reservations.filter(
      (record) =>
        record.appendIndex !== undefined &&
        record.reentrant === false &&
        Number.isFinite(record.queueWaitMs),
    );
    assert(
      appendReservations.length > 0,
      `No transcript append reservation observations: ${JSON.stringify(reservations.map(({ operation, caller, workerOperations, appendIndex }) => ({ operation, caller, workerOperations, appendIndex })))}`,
    );
    const appendQueueWait = new Map();
    for (const record of appendReservations) {
      appendQueueWait.set(
        record.appendIndex,
        (appendQueueWait.get(record.appendIndex) ?? 0) + record.queueWaitMs,
      );
    }
    console.log(
      JSON.stringify({
        fixture: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
        environment: environment(),
        source,
        result,
        elapsedMs: finishedAt - start,
        appendLatencyMs: quantiles(appendLatencies),
        appendQueueWaitMs: quantiles([...appendQueueWait.values()]),
        appendMutationQueueWaitMs: quantiles(
          appendReservations
            .filter((record) => record.workerOperations?.includes("transcripts"))
            .map((record) => record.queueWaitMs),
        ),
        cpu,
        heapBefore: heapStart,
        heapAfter,
        ...(profileDirectory ? { profileThreads } : {}),
        transactions,
        closes,
        reservations,
      }),
    );
  } finally {
    reservationChannel.unsubscribe(observeReservation);
    sessionWriteChannel.unsubscribe(observeReservation);
    channel.close();
    await agent.closeOpenClawAgentDatabasesAsync();
    lease.release();
  }
}
try {
  if (values.prepare) {
    await prepare();
  } else if (values.flow || values["restore-flow"]) {
    await measureFlow();
  } else {
    await measureOwners();
  }
} finally {
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}
