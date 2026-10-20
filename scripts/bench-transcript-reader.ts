// Synthetic compiled-worker benchmark; never reads operator state.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../src/agents/test-helpers/agent-message-fixtures.js";
import { writeSessionEntry } from "../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { readSessionTranscriptModelContext } from "../src/config/sessions/session-accessor.sqlite-model-context.js";
import { appendTranscriptEventsInTransaction } from "../src/config/sessions/session-accessor.sqlite-transcript-store.js";
import { unwrapSessionTranscriptWorkerReply } from "../src/config/sessions/session-history-worker-errors.js";
import { SESSION_TRANSCRIPT_WORKER_LIMITS } from "../src/config/sessions/session-transcript-read-pools.js";
import type {
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerReply,
} from "../src/config/sessions/session-transcript-worker.types.js";
import { ensureSqliteLibrarySelected } from "../src/infra/bun-sqlite-library.js";
import { getDatabaseEngineSelection } from "../src/infra/database-engine/context.js";
import { runtimeProcessEntrypoints } from "../src/infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../src/infra/runtime-worker-url.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../src/infra/sqlite-database-admission-turn.js";
import { runSqliteImmediateTransactionSync } from "../src/infra/sqlite-transaction.js";
import { readDatabasePathIdentitySync } from "../src/infra/sqlite-worker-identity.js";
import {
  getTrackedWorkerLifecycleSnapshot,
  getTrackedWorkerPoolSnapshot,
  sampleTrackedWorkerMemory,
} from "../src/infra/worker-cpu.js";
import { closeDefaultRetainedNativeWorkerSource } from "../src/infra/worker-native-lifecycle.js";
import { WorkerTaskPool } from "../src/infra/worker-task-pool.js";
import { closeOpenClawAgentDatabasesAsync } from "../src/state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../src/state/openclaw-state-db-cache.js";
import { requireNativeSqliteDatabase } from "../src/test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const { values } = parseArgs({ options: { output: { type: "string" } } });
assert.equal(process.env.NODE_COMPILE_CACHE, undefined, "run with an empty Node compile cache");
const root = fileURLToPath(new URL("../", import.meta.url));
const workerUrl = resolveRuntimeWorkerUrl({ ...runtimeProcessEntrypoints.sessionTranscript, root });
assert.equal(
  fileURLToPath(workerUrl),
  path.join(root, "dist/config/sessions/session-transcript.worker.js"),
  "pnpm build before benchmarking",
);
const workerSha256 = createHash("sha256")
  .update(await fs.readFile(workerUrl))
  .digest("hex");
type Input = Extract<SessionTranscriptWorkerInput, { kind: "model-context" }>;
type Reply = SessionTranscriptWorkerReply<Input["kind"]>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function run() {
  return withOpenClawTestState(
    { scenario: "minimal", label: "transcript-reader-benchmark" },
    async (state) => {
      const sessionId = "transcript-reader-benchmark";
      const sessionKey = `agent:main:${sessionId}`;
      const timestamp = Date.parse("2026-07-01T10:00:00.000Z");
      const records = [
        {
          type: "session",
          version: 3,
          id: sessionId,
          cwd: "/synthetic/workspace",
          timestamp: new Date(timestamp).toISOString(),
        },
        ...Array.from({ length: 80 }, (_, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index ? `message-${index - 1}` : null,
          timestamp: new Date(timestamp + index).toISOString(),
          message:
            index % 2
              ? makeAgentAssistantMessage({
                  content: [{ type: "text", text: `Synthetic record ${index}.` }],
                  timestamp: timestamp + index,
                })
              : makeAgentUserMessage({
                  content: `Synthetic record ${index}.`,
                  timestamp: timestamp + index,
                }),
        })),
      ];
      const opened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const database = Object.assign(opened, { db: requireNativeSqliteDatabase(opened.db) });
      const target = { agentId: "main", sessionId, sessionKey, storePath: database.path };
      runSqliteImmediateTransactionSync(database.db, () => {
        writeSessionEntry(database, sessionKey, { sessionId, updatedAt: timestamp });
        assert.equal(
          appendTranscriptEventsInTransaction(database, target, records),
          records.length,
        );
      });
      await closeOpenClawAgentDatabasesAsync(state.root);
      const input: Input = {
        kind: "model-context",
        target,
        expectedIdentity: readDatabasePathIdentitySync(database.path),
      };
      const expected = readSessionTranscriptModelContext(target);
      assert.equal(
        expected.events.filter((event) => isRecord(event) && event.type === "message").length,
        80,
      );
      assert(
        !getTrackedWorkerPoolSnapshot().workerPools.some((pool) =>
          pool.script.endsWith("session-transcript.worker.js"),
        ),
        "setup warmed a transcript worker",
      );
      const pool = new WorkerTaskPool<Input, Reply>({
        workerUrl,
        maxWorkers: 1,
        workerOptions: { resourceLimits: SESSION_TRANSCRIPT_WORKER_LIMITS },
        prepareWorker() {
          ensureSqliteLibrarySelected();
          return {
            options: { workerData: { databaseEngineSelection: getDatabaseEngineSelection() } },
          };
        },
      });
      const read = (request: Input) =>
        runWithSqliteDatabaseAdmissionTurn([database.path], async () => {
          assert.deepEqual(readDatabasePathIdentitySync(database.path), input.expectedIdentity);
          return unwrapSessionTranscriptWorkerReply(
            await pool.run(request, {
              timeoutMs: 60_000,
              inputBytes: JSON.stringify(request).length * 2,
            }),
          );
        });
      const samples = [];
      const settled = [];
      try {
        for (let index = 0; index < 31; index++) {
          const cpu = process.cpuUsage();
          const started = performance.now();
          const result = await read(input);
          const elapsedMs = performance.now() - started;
          const used = process.cpuUsage(cpu);
          assert.deepEqual(result, expected);
          samples.push({
            cold: index === 0,
            elapsedMs,
            cpuUserUs: used.user,
            cpuSystemUs: used.system,
          });
        }
        const limits = { maxEvents: 20, maxBytes: 1024 * 1024 };
        const bounded = await read({ ...input, limits });
        assert.deepEqual(bounded, readSessionTranscriptModelContext(target, undefined, limits));
        assert(bounded.events.length < expected.events.length);
        const drained = performance.now();
        for (const afterMs of [2000, 5000]) {
          await delay(Math.max(0, drained + afterMs - performance.now()));
          sampleTrackedWorkerMemory();
          await delay(25);
          const workers = sampleTrackedWorkerMemory().workerHeaps.filter((worker) =>
            worker.script.endsWith("session-transcript.worker.js"),
          );
          assert.equal(workers.length, 1);
          const worker = workers[0];
          assert(
            worker && worker.sampleAgeMs !== undefined && worker.sampleAgeMs <= 250,
            "worker memory sample is stale",
          );
          settled.push({
            afterDrainMs: performance.now() - drained,
            processRss: process.memoryUsage.rss(),
            worker,
          });
        }
        const snapshot = pool.getSnapshot();
        assert.equal(snapshot.workersCreated, 1);
        assert.equal(snapshot.workers, 1);
        assert.equal(snapshot.activeTasks, 0);
        assert.equal(snapshot.pendingTasks, 0);
        return {
          fixtureSha256: hash(records),
          responseSha256: hash(expected),
          samples,
          settled,
          pool: snapshot,
        };
      } finally {
        await pool.close();
        assert.equal(pool.getSnapshot().workers, 0);
        await closeOpenClawAgentDatabasesAsync(state.root);
        await closeOpenClawStateDatabaseAsync();
      }
    },
  );
}

let measured;
try {
  measured = await run();
} finally {
  await closeDefaultRetainedNativeWorkerSource();
  // TSX's sync service is instrumentation, but it must also join before declaring cleanup.
  const require = createRequire(import.meta.url);
  const tsxRequire = createRequire(require.resolve("tsx/package.json"));
  await tsxRequire("esbuild").stop();
  const deadline = performance.now() + 5000;
  while (getTrackedWorkerLifecycleSnapshot().workerCount && performance.now() < deadline) {
    await delay(10);
  }
  assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, 0, "benchmark leaked a worker");
}
const report = {
  schemaVersion: 1,
  runtime: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpu: os.cpus()[0]?.model,
  workerSha256,
  methodology:
    "One compiled model-context worker; 80 synthetic messages; one cold and 30 warm full reads plus one bounded read. Worker heap is isolate-local; CPU and RSS include the source host and all workers. No forced GC, observer hooks, or compile cache. OS caches are not flushed. This isolates the reader; it is not a Gateway load benchmark.",
  ...measured,
  cleanup: { success: true, workerCount: 0 },
};
const json = JSON.stringify(report, null, 2) + "\n";
if (values.output) {
  await fs.writeFile(values.output, json, { flag: "wx" });
}
process.stdout.write(json);
