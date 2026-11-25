// Synthetic persistSessionTranscriptTurn benchmark; no model or live state.
// Install diagnostics before loading the transcript workers.
// Count mode needs OPENCLAW_TURN_TRACE; timing: --writers 4 --seconds 10 without a trace.
import "./bench-transcript-turn-preload.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../src/config/sessions/session-transcript-reconcile.js";
import { installGatewayDatabaseEngine } from "../src/gateway/server-database-engine.js";
import { installDatabaseProcessRole } from "../src/infra/database-engine/admission-scope.js";
import { onInternalDiagnosticEvent } from "../src/infra/diagnostic-events.js";
import { cleanupSessionStateForTest } from "../src/test-utils/session-state-cleanup.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    engine: { type: "string", default: "sqlite" },
    connection: { type: "string" },
    prefix: { type: "string", default: "transcript_turn" },
    sessions: { type: "string", default: "2000" },
    turns: { type: "string", default: "5000" },
    writers: { type: "string" },
    seconds: { type: "string", default: "10" },
    "caller-ids": { type: "boolean", default: false },
    "check-budget": { type: "boolean", default: false },
  },
});
assert(values.root, "--root is required");
assert(values.engine === "sqlite" || values.engine === "postgres");
const throughput = values.writers !== undefined;
const trace = process.env.OPENCLAW_TURN_TRACE;
assert(trace || throughput, "OPENCLAW_TURN_TRACE is required for count mode");
const writers = Number(values.writers ?? "4");
const seconds = Number(values.seconds);
assert(Number.isSafeInteger(writers) && writers > 0, "--writers must be a positive integer");
assert(Number.isFinite(seconds) && seconds > 0, "--seconds must be positive");
assert(Number.isSafeInteger(Number(values.sessions)) && Number(values.sessions) > 0);
assert(Number.isSafeInteger(Number(values.turns)) && Number(values.turns) >= 0);
assert(!throughput || !values["check-budget"], "--check-budget requires count mode");
const root = path.resolve(values.root);
fs.mkdirSync(root);
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
fs.writeFileSync(
  process.env.OPENCLAW_CONFIG_PATH,
  JSON.stringify({
    agents: { entries: { main: {} } },
    ...(values.engine === "postgres"
      ? {
          database: {
            engine: "postgres",
            postgres: { connection: values.connection, schemaPrefix: values.prefix },
          },
        }
      : {}),
  }),
);
installDatabaseProcessRole("gateway");
await installGatewayDatabaseEngine();
const storePath = path.join(root, "agents/main/sessions/sessions.json");
function mark(value: object) {
  if (!trace) {
    return;
  }
  fs.appendFileSync(
    trace,
    JSON.stringify({ ...value, at: performance.timeOrigin + performance.now() }) + "\n",
  );
}
const unsubscribe = trace
  ? onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "worker.request" && event.phase === "completed") {
          mark({ request: event.requestClass });
        }
      },
      { include: ["worker.request"] },
    )
  : () => {};
const scope = (sessionId: string) => ({
  agentId: "main",
  sessionKey: `agent:main:${sessionId}`,
  sessionId,
  storePath,
});
const messages = (count: number, iteration: string) =>
  Array.from({ length: count }, (_, offset) => ({
    ...(values["caller-ids"] ? { eventId: `message-${iteration}-${offset}` } : {}),
    message: {
      role: offset % 2 ? "assistant" : "user",
      content: `Synthetic turn ${iteration} message ${offset}.`,
    },
  }));
try {
  for (let index = 0; index < Number(values.sessions); index++) {
    const sessionId = `fixture-${index}`;
    await upsertSessionEntryCore(scope(sessionId), { sessionId, updatedAt: 1 });
  }
  const fixture = scope("fixture-0");
  for (let start = 0; start < Number(values.turns) * 2; start += 128) {
    await persistSessionTranscriptTurn(fixture, {
      touchSessionEntry: false,
      messages: Array.from(
        { length: Math.min(128, Number(values.turns) * 2 - start) },
        (_, offset) => ({
          eventId: `fixture-message-${start + offset}`,
          message: {
            role: (start + offset) % 2 ? "assistant" : "user",
            content: `Synthetic history ${start + offset}.`,
          },
        }),
      ),
    });
  }
  await waitForSessionTranscriptIndexReconcilesInStateDir(root);
  if (throughput) {
    const targets = Array.from({ length: writers }, (_, index) => scope(`writer-${index}`));
    for (const [index, target] of targets.entries()) {
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      for (let warmup = 0; warmup < 5; warmup++) {
        const result = await persistSessionTranscriptTurn(target, {
          messages: messages(2, `${index}-warm-${warmup}`),
          touchSessionEntry: false,
        });
        assert.equal(result.messages.length, 2);
        assert(result.messages.every((message) => message.appended));
      }
    }
    const errors: string[] = [];
    const durations: number[][] = targets.map(() => []);
    const loadBefore = os.loadavg();
    const started = performance.now();
    const deadline = started + seconds * 1000;
    await Promise.all(
      targets.map(async (target, index) => {
        while (performance.now() < deadline && errors.length === 0) {
          const before = performance.now();
          try {
            const result = await persistSessionTranscriptTurn(target, {
              messages: messages(2, `${index}-${durations[index]!.length}`),
              touchSessionEntry: false,
            });
            assert.equal(result.messages.length, 2);
            assert(result.messages.every((message) => message.appended));
            durations[index]!.push(performance.now() - before);
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
      }),
    );
    const elapsedMs = performance.now() - started;
    const sorted = durations.flat().toSorted((left, right) => left - right);
    const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
    console.log(
      JSON.stringify({
        mode: "throughput",
        scope: "concurrent public callers sharing one agent writer owner",
        engine: values.engine,
        concurrentCallers: writers,
        requestedSeconds: seconds,
        idMode: values["caller-ids"] ? "caller" : "minted",
        instrumented: Boolean(trace),
        completed: sorted.length,
        completedByWriter: durations.map((samples) => samples.length),
        latenciesMsByWriter: durations,
        elapsedMs,
        turnsPerSecond: sorted.length / (elapsedMs / 1000),
        p50: percentile(0.5),
        p95: percentile(0.95),
        errors,
        node: process.version,
        loadBefore,
        loadAfter: os.loadavg(),
      }),
    );
    assert.equal(errors.length, 0, "Throughput workload failed");
    assert(sorted.length > 0, "Throughput workload completed no turns");
  } else {
    for (const count of [1, 2, 4]) {
      const target = scope(`measured-${count}`);
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      for (let iteration = -5; iteration < 10; iteration++) {
        mark({ marker: "start", count, iteration });
        const started = performance.now();
        const result = await persistSessionTranscriptTurn(target, {
          messages: messages(count, String(iteration)),
          touchSessionEntry: false,
        });
        const elapsedMs = performance.now() - started;
        mark({ marker: "end", count, iteration, elapsedMs });
        assert.equal(result.messages.length, count);
        assert(result.messages.every((message) => message.appended));
      }
    }
  }
  if (!throughput) {
    console.log(
      JSON.stringify({
        engine: values.engine,
        sessions: Number(values.sessions),
        turns: Number(values.turns),
        node: process.version,
        load: os.loadavg(),
        root,
        idMode: values["caller-ids"] ? "caller" : "minted",
      }),
    );
  }
} finally {
  await cleanupSessionStateForTest({ stateDir: root });
  unsubscribe();
}

// Analyze only timed intervals; setup and shutdown are deliberately outside the budget.
if (!throughput && trace) {
  type Sample = {
    count: number;
    requests: number;
    statements: number;
    trips: number;
    writeStatements: number;
    writeTrips: number;
    writeTransactions: number;
    elapsedMs: number;
  };
  const samples: Sample[] = [];
  let active: Sample | undefined;
  const writing = new Set<number>();
  for await (const line of createInterface({ input: fs.createReadStream(trace) })) {
    const record = JSON.parse(line) as {
      marker?: string;
      count?: number;
      iteration?: number;
      elapsedMs?: number;
      sql?: string;
      engine?: string;
      request?: string;
      source?: string;
      threadId?: number;
    };
    if (record.source === "native") {
      continue;
    }
    if (record.marker === "start") {
      active =
        record.iteration !== undefined && record.iteration >= 0 && record.count !== undefined
          ? {
              count: record.count,
              requests: 0,
              statements: 0,
              trips: 0,
              writeStatements: 0,
              writeTrips: 0,
              writeTransactions: 0,
              elapsedMs: 0,
            }
          : undefined;
    } else if (record.marker === "end" && active) {
      active.elapsedMs = record.elapsedMs!;
      samples.push(active);
      active = undefined;
    } else if (active && record.request) {
      active.requests += 1;
    } else if (record.sql && record.threadId !== undefined) {
      const beginsWrite =
        /^BEGIN IMMEDIATE\b/iu.test(record.sql) || record.sql.includes("pg_advisory_xact_lock(");
      if (beginsWrite) {
        writing.add(record.threadId);
      }
      if (active) {
        const statements = record.sql.split(";").filter((statement) => statement.trim()).length;
        const trips = Number(record.engine === "postgres");
        active.statements += statements;
        active.trips += trips;
        if (writing.has(record.threadId)) {
          active.writeStatements += statements;
          active.writeTrips += trips;
          active.writeTransactions += Number(beginsWrite);
        }
      }
      if (/^(?:COMMIT|ROLLBACK)\s*;?$/iu.test(record.sql)) {
        writing.delete(record.threadId);
      }
    }
  }
  const budget: Record<number, number> =
    values.engine === "postgres" ? { 1: 12, 2: 7, 4: 7 } : { 1: 13, 2: 11, 4: 11 };
  for (const count of [1, 2, 4]) {
    const selected = samples.filter((sample) => sample.count === count);
    assert.equal(selected.length, 10);
    const elapsed = selected.map((sample) => sample.elapsedMs).toSorted((a, b) => a - b);
    console.log(
      JSON.stringify({
        engine: values.engine,
        count,
        samples: selected,
        p50: (elapsed[4]! + elapsed[5]!) / 2,
        p95: elapsed[9],
      }),
    );
  }
  if (values["check-budget"]) {
    for (const count of [1, 2, 4]) {
      const selected = samples.filter((sample) => sample.count === count);
      assert.equal(new Set(selected.map((sample) => sample.requests)).size, 1);
      assert.equal(selected[0]!.requests, 1);
      const expected = budget[count]! + Number(values["caller-ids"] && count > 1);
      for (const sample of selected) {
        assert.equal(sample.writeTransactions, 1);
        assert.equal(sample.writeStatements, expected);
        assert.equal(sample.writeTrips, values.engine === "postgres" ? expected - 1 : 0);
      }
    }
  }
}
