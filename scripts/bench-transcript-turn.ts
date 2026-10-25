// Synthetic persistSessionTranscriptTurn benchmark; no model or live state.
// Install diagnostics before loading the transcript workers.
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
import { cleanupSessionStateForTest } from "../src/test-utils/session-state-cleanup.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    engine: { type: "string", default: "sqlite" },
    connection: { type: "string" },
    prefix: { type: "string", default: "pgturncommit" },
    sessions: { type: "string", default: "2000" },
    turns: { type: "string", default: "5000" },
    "check-budget": { type: "boolean", default: false },
  },
});
assert(values.root, "--root is required");
assert(values.engine === "sqlite" || values.engine === "postgres");
const root = path.resolve(values.root);
fs.mkdirSync(root, { recursive: true });
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
const trace = process.env.OPENCLAW_TURN_TRACE;
assert(trace, "OPENCLAW_TURN_TRACE is required");
function mark(value: object) {
  fs.appendFileSync(
    trace!,
    JSON.stringify({ ...value, at: performance.timeOrigin + performance.now() }) + "\n",
  );
}
const scope = (sessionId: string) => ({
  agentId: "main",
  sessionKey: `agent:main:${sessionId}`,
  sessionId,
  storePath,
});
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
  for (const count of [1, 2, 4]) {
    const target = scope(`measured-${count}`);
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    for (let iteration = -5; iteration < 10; iteration++) {
      const messages = Array.from({ length: count }, (_, offset) => ({
        eventId: `message-${iteration}-${offset}`,
        message: {
          role: offset % 2 ? "assistant" : "user",
          content: `Synthetic turn ${iteration} message ${offset}.`,
        },
      }));
      mark({ marker: "start", count, iteration });
      const started = performance.now();
      const result = await persistSessionTranscriptTurn(target, {
        messages,
        touchSessionEntry: false,
      });
      const elapsedMs = performance.now() - started;
      mark({ marker: "end", count, iteration, elapsedMs });
      assert.equal(result.messages.length, count);
      assert(result.messages.every((message) => message.appended));
    }
  }
  console.log(
    JSON.stringify({
      engine: values.engine,
      sessions: Number(values.sessions),
      turns: Number(values.turns),
      node: process.version,
      load: os.loadavg(),
      root,
    }),
  );
} finally {
  await cleanupSessionStateForTest({ stateDir: root });
}

// Analyze only timed intervals; setup and shutdown are deliberately outside the budget.
type Sample = { count: number; statements: number; trips: number; elapsedMs: number };
const samples: Sample[] = [];
let active: Sample | undefined;
for await (const line of createInterface({ input: fs.createReadStream(trace) })) {
  const record = JSON.parse(line) as {
    marker?: string;
    count?: number;
    iteration?: number;
    elapsedMs?: number;
    sql?: string;
    engine?: string;
  };
  if (record.marker === "start") {
    active =
      record.iteration !== undefined && record.iteration >= 0 && record.count !== undefined
        ? { count: record.count, statements: 0, trips: 0, elapsedMs: 0 }
        : undefined;
  } else if (record.marker === "end" && active) {
    active.elapsedMs = record.elapsedMs!;
    samples.push(active);
    active = undefined;
  } else if (active && record.sql) {
    active.statements += record.sql.split(";").filter((statement) => statement.trim()).length;
    active.trips += Number(record.engine === "postgres");
  }
}
const baseline: Record<number, number> =
  values.engine === "postgres" ? { 1: 18, 2: 25, 4: 39 } : { 1: 15, 2: 28, 4: 50 };
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
  if (values["check-budget"]) {
    assert.equal(new Set(selected.map((sample) => sample.statements)).size, 1);
    assert(
      selected.every((sample) => sample.statements > 0 && sample.statements < baseline[count]!),
    );
    if (values.engine === "postgres") {
      assert.equal(new Set(selected.map((sample) => sample.trips)).size, 1);
      assert(selected.every((sample) => sample.trips > 0 && sample.trips < baseline[count]! - 1));
    }
  }
}
