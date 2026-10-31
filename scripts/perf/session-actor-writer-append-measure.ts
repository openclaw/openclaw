/**
 * Real synchronous SQLite actor append kernel and native receipt transport, with synthetic
 * admission grants. This process represents the writer isolate, not Gateway main-thread CPU
 * or broker queue wait. Multiple warm actors exercise resident-byte accounting; one hides it.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-actor-writer-append-measure.ts \
 *   --output .local/append-base --rows 3000 --sessions 2 --iterations 2000 --mode timing
 * Repeat in counterbalanced order for candidate, then separately with --mode allocation.
 * --mode profile saves a CPU profile. --owner-file loads a saved baseline transcript-window
 * owner. Setup, hydration and durable readback are outside measurement.
 * --owner-module selects another source owner for --owner-file substitution.
 * --message-view exercises post-commit reload decisions for message appends.
 * --stale-view forces the existing full reload after each message append.
 * requestBytesPerAppend measures V8 command serialization, excluding broker framing.
 * Acceptance: identical committed rows/projections, less CPU or allocation, no material
 * untraced latency/GC regression. Report host load and rounded actor phase diagnostics.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, serialize } from "node:v8";
import { MessageChannel, MessagePort, receiveMessageOnPort } from "node:worker_threads";
import type {
  SessionActorHotState,
  SessionActorOperations,
} from "../../src/config/sessions/session-actor-contract.js";
import type { SqliteWorkerCommand } from "../../src/infra/sqlite-worker-contract.js";
import type { AgentWorkerOperationContext } from "../../src/state/openclaw-agent-operation-context.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    rows: { type: "string", default: "3000" },
    sessions: { type: "string", default: "2" },
    iterations: { type: "string", default: "2000" },
    mode: { type: "string", default: "timing" },
    "owner-file": { type: "string" },
    "owner-module": {
      type: "string",
      default: "src/config/sessions/session-actor-transcript-window.worker.ts",
    },
    "message-view": { type: "boolean", default: false },
    "stale-view": { type: "boolean", default: false },
  },
});
assert(values.output, "--output must name a new directory");
assert(["timing", "allocation", "profile"].includes(values.mode));
const rows = Number(values.rows),
  sessions = Number(values.sessions),
  iterations = Number(values.iterations);
assert([rows, sessions, iterations].every((value) => Number.isSafeInteger(value) && value > 0));
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output);
for (const name of ["home", "state", "tmp"]) {
  mkdirSync(path.join(output, name));
}
Object.assign(process.env, {
  HOME: path.join(output, "home"),
  OPENCLAW_HOME: path.join(output, "home"),
  OPENCLAW_STATE_DIR: path.join(output, "state"),
  TMPDIR: path.join(output, "tmp"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
});
const ownerUrl = pathToFileURL(path.resolve(values["owner-module"]));
const sourceUrl = values["owner-file"]
  ? pathToFileURL(path.resolve(values["owner-file"]))
  : ownerUrl;
const sourceDigest = createHash("sha256").update(readFileSync(sourceUrl)).digest("hex");
let ownerLoaded = false;
registerHooks({
  load(url, context, nextLoad) {
    if (url === ownerUrl.href) {
      ownerLoaded = true;
      const loaded = nextLoad(sourceUrl.href, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { isRecord } = await import("../../packages/normalization-core/src/record-coerce.ts");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { readOpenClawAgentDatabaseIdentity } =
  await import("../../src/state/openclaw-agent-db-identity.js");
const { runSqliteImmediateTransactionSync } = await import("../../src/infra/sqlite-transaction.js");
const { createSqliteWorkerOperationAdmission, withSqliteWorkerOperationAdmission } =
  await import("../../src/infra/sqlite-worker-operation-admission.js");
const { createSessionActorWorker } =
  await import("../../src/config/sessions/session-actor.worker.js");
assert(ownerLoaded, "Selected append owner was not loaded");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { appendTranscriptEventsInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
const { readTranscriptEventRows } =
  await import("../../src/config/sessions/session-accessor.sqlite-read.js");
const { getSessionKysely } =
  await import("../../src/config/sessions/session-accessor.sqlite-scope.js");
const { executeSqliteQuerySync } = await import("../../src/infra/kysely-sync.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");

const database = openOpenClawAgentDatabase({ agentId: "main", env: process.env });
const identity = readOpenClawAgentDatabaseIdentity(database);
const physical = {
  kind: "file" as const,
  physicalIdentity: identity.identity,
  birthtime: identity.birthtime,
  nativeLocation: database.path,
};
const scopes = Array.from({ length: sessions }, (_, index) => ({
  agentId: "main",
  path: database.path,
  storePath: database.path,
  sessionKey: `agent:main:append-bench-${index}`,
  sessionId: `append-bench-${index}`,
}));
const text = "Synthetic café 雪 tool output. ".repeat(100);
function event(index: number) {
  const envelope = {
    id: `event-${index}`,
    parentId: index ? `event-${index - 1}` : null,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
  };
  if (index > 64 && index % 64 === 0) {
    return {
      ...envelope,
      type: "compaction",
      firstKeptEntryId: `event-${index - 32}`,
      summary: "Synthetic compaction summary",
      tokensBefore: 8000,
    };
  }
  const message =
    index % 4 === 0
      ? { role: "user", content: "Synthetic question" }
      : index % 4 === 1
        ? {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `call-${index}`,
                name: "read",
                arguments: { path: "synthetic.txt" },
              },
            ],
          }
        : index % 4 === 2
          ? {
              role: "toolResult",
              toolCallId: `call-${index - 1}`,
              toolName: "read",
              isError: false,
              content: [{ type: "text", text }],
            }
          : { role: "assistant", content: [{ type: "text", text }] };
  return { ...envelope, type: "message" as const, message };
}
const seeded = Array.from({ length: rows }, (_, index) => event(index));
for (const scope of scopes) {
  runSqliteImmediateTransactionSync(database.db, () => {
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    appendTranscriptEventsInTransaction(
      database,
      scope,
      [
        {
          type: "session",
          id: scope.sessionId,
          version: 3,
          timestamp: "2023-11-14T22:13:19.000Z",
          cwd: "/synthetic",
        },
        ...seeded,
      ],
      { scheduleProjectionReconcile: false },
    );
  });
}

let latestReceipt: unknown;
let latestDiagnostic: Parameters<AgentWorkerOperationContext["writeTransaction"]>[3];
const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
const { port1, port2 } = new MessageChannel();
const postMessage = port1.postMessage.bind(port1);
port1.postMessage = (message, transferList) => {
  if (Array.isArray(transferList)) {
    postMessage(message, transferList);
  } else {
    postMessage(message, transferList);
  }
  const received: unknown = receiveMessageOnPort(port2)?.message;
  assert(isRecord(received), "Missing native receipt/admission frame");
  if (received.kind === "native-commit" || received.kind === "native-settlement") {
    if (received.kind === "native-commit" && isRecord(received.committed)) {
      latestReceipt = received.committed.facts;
    }
  } else {
    admission.port.postMessage(
      received,
      received.port instanceof MessagePort ? [received.port] : [],
    );
    admission.service();
  }
};
const context: AgentWorkerOperationContext = {
  open: () => database,
  options: { agentId: "main", path: database.path, env: process.env },
  admit() {},
  writeTransaction(operationLabel, _owner, run, diagnosticContext) {
    latestDiagnostic = diagnosticContext;
    return runSqliteImmediateTransactionSync(database.db, () => run(database), {
      operationLabel,
      diagnosticContext,
    });
  },
};
let actor = createSessionActorWorker(context, () => physical);
const execute = (command: SqliteWorkerCommand<SessionActorOperations>) =>
  withSqliteWorkerOperationAdmission({ port: port1 }, () => actor.execute(command));
const targets = scopes.map((scope) => ({ database: physical, sessionKey: scope.sessionKey }));
const hot: SessionActorHotState[] = targets.map((target) => {
  const result = execute({ type: "session.actor.read", input: { target } });
  assert(!("kind" in result));
  return result;
});
const commands: SqliteWorkerCommand<SessionActorOperations>[] = Array.from(
  { length: iterations },
  (_, index) => {
    const slot = index % sessions;
    const appended = event(rows + Math.floor(index / sessions));
    const input = {
      target: targets[slot]!,
      commandId: `append-${index}`,
      phaseId: "synthetic-turn",
      entryReference: hot[slot]!.writeToken,
    };
    if ("message" in appended) {
      const { message, ...envelope } = appended;
      return {
        type: "session.actor.appendTranscriptEvent",
        input: {
          ...input,
          append: {
            kind: "metadata",
            input: {
              scope: scopes[slot]!,
              event: envelope,
              message: {
                messageJson: JSON.stringify(message),
                cwd: "/synthetic",
                validateTurn: false,
              },
              options: {},
              ...(values["stale-view"]
                ? { view: { loadedVersion: { generation: null, rawSeq: null, updatedAt: null } } }
                : values["message-view"]
                  ? { view: {} }
                  : {}),
            },
          },
        },
      };
    }
    return {
      type: "session.actor.appendTranscriptEvent",
      input: {
        ...input,
        sessionId: scopes[slot]!.sessionId,
        lifecycleRevision: null,
        eventJson: JSON.stringify(appended),
      },
    };
  },
);
const inspector = new Session();
const requestBytesPerAppend =
  commands.reduce((total, command) => total + serialize(command).byteLength, 0) / iterations;
const gc = new GCProfiler();
const timings: number[] = [];
const phases: Record<string, number[]> = {};
try {
  globalThis.gc?.();
  await setImmediate();
  const memoryBefore = process.memoryUsage(),
    hostLoadBefore = loadavg();
  if (values.mode !== "timing") {
    inspector.connect();
  }
  if (values.mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (values.mode === "profile") {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  gc.start();
  const cpu = process.threadCpuUsage(),
    started = performance.now();
  for (const [index, command] of commands.entries()) {
    latestReceipt = undefined;
    const begin = performance.now();
    const result = execute(command);
    timings.push(performance.now() - begin);
    assert("kind" in result && result.kind === "committed", JSON.stringify(result));
    assert(
      isRecord(latestReceipt) &&
        latestReceipt.kind === "committed" &&
        isRecord(latestReceipt.receipt),
      "Append lost native receipt",
    );
    const receipt = latestReceipt.receipt;
    assert(isRecord(receipt.postimage) && typeof receipt.postimage.writeToken === "string");
    const next = commands[index + sessions];
    if (next && next.type !== "session.actor.read") {
      next.input.entryReference = receipt.postimage.writeToken;
    }
    for (const [key, value] of Object.entries(latestDiagnostic ?? {})) {
      if (key.endsWith("Ms") && typeof value === "number") {
        (phases[key] ??= []).push(value);
      }
    }
  }
  const elapsedMs = performance.now() - started,
    used = process.threadCpuUsage(cpu),
    gcProfile = gc.stop();
  const memoryAfter = process.memoryUsage();
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: typeof profile.head): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    writeFileSync(path.join(output, "allocation.json"), JSON.stringify(profile));
  }
  if (values.mode === "profile") {
    writeFileSync(
      path.join(output, "writer.cpuprofile"),
      JSON.stringify((await inspector.post("Profiler.stop")).profile),
    );
  }
  inspector.disconnect();
  const digest = createHash("sha256");
  const navigationDigest = createHash("sha256");
  const warm = targets.map((target) => execute({ type: "session.actor.read", input: { target } }));
  actor.close();
  actor = createSessionActorWorker(context, () => physical);
  for (const [slot, scope] of scopes.entries()) {
    const stored = readTranscriptEventRows(database, scope.sessionId);
    const appendedCount = Math.floor((iterations + sessions - 1 - slot) / sessions);
    assert.equal(stored.length, rows + 1 + appendedCount);
    for (let index = 0; index < rows + appendedCount; index++) {
      assert.deepEqual(JSON.parse(stored[index + 1]!.eventJson), event(index));
      digest.update(stored[index + 1]!.eventJson);
    }
    const cold = execute({ type: "session.actor.read", input: { target: targets[slot]! } });
    const previous = warm[slot]!;
    assert(!("kind" in cold) && !("kind" in previous));
    assert.deepEqual(cold.transcript.watermark, previous.transcript.watermark);
    assert.deepEqual(cold.transcript.projection, previous.transcript.projection);
    // Incomplete resident windows may omit projection receipts. Compare durable navigation
    // and active-path indexes between arms independently of that optional publication.
    const db = getSessionKysely(database.db);
    navigationDigest.update(
      JSON.stringify(
        executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("transcript_events")
            .select([
              "seq",
              "navigation_json",
              "navigation_type",
              "navigation_custom_type",
              "navigation_display",
              "message_role",
              "navigation_last_type",
              "navigation_last_custom_type",
              "navigation_valid",
            ])
            .where("session_id", "=", scope.sessionId)
            .orderBy("seq", "asc"),
        ).rows,
      ),
    );
    navigationDigest.update(
      JSON.stringify(
        executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_transcript_active_events")
            .selectAll()
            .where("session_id", "=", scope.sessionId)
            .orderBy("active_position", "asc"),
        ).rows,
      ),
    );
  }
  const summarize = (samples: number[]) => {
    const ordered = samples.toSorted((a, b) => a - b);
    return {
      count: samples.length,
      mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
      p50: ordered[Math.floor(samples.length * 0.5)],
      p99: ordered[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))],
    };
  };
  const result = {
    sourceDigest,
    mode: values.mode,
    rows,
    sessions,
    iterations,
    requestBytesPerAppend,
    elapsedMs,
    cpuUsPerAppend: (used.user + used.system) / iterations,
    sampledBytesPerAppend: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    appendMs: summarize(timings),
    roundedActorPhasesMs: Object.fromEntries(
      Object.entries(phases).map(([key, samples]) => [key, summarize(samples)]),
    ),
    gc: Object.fromEntries(
      [...new Set(gcProfile?.statistics.map((sample) => sample.gcType))].map((kind) => {
        const samples = gcProfile!.statistics
          .filter((sample) => sample.gcType === kind)
          .map((sample) => sample.cost / 1000);
        return [
          kind,
          {
            ...summarize(samples),
            totalMs: samples.reduce((sum, value) => sum + value, 0),
            maxMs: Math.max(...samples),
          },
        ];
      }),
    ),
    memoryBefore,
    memoryAfter,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    digest: digest.digest("hex"),
    navigationDigest: navigationDigest.digest("hex"),
    node: process.version,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(path.join(output, "gc.json"), JSON.stringify(gcProfile));
  console.log(JSON.stringify(result));
} finally {
  actor.close();
  admission.finish();
  port1.close();
  port2.close();
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
