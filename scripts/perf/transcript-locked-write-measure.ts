/**
 * Locked transcript append CPU/allocation versus retained history length.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-locked-write-measure.ts
 *   --iterations 100 --sessions 1000 --lengths 100,1000,10000 [--allocations]
 *   [--owner /absolute/base-session-message-rewrite.worker.ts]
 * Alternate base/candidate processes; allocation sampling is a separate pass.
 * Uses the real bound transcript worker and transfer framing with synthetic grants.
 * Timed work includes commit, its snapshot comparison/publication, and receipt decode.
 * Fixture creation, initial reads, and final stored-row digests are outside timing.
 * Statement tracing runs for one separate append, outside CPU/allocation measurement.
 * Accept identical stored/returned rows with lower work, CPU or allocation; this
 * owner measurement makes no claim about whole-Gateway latency or live authority.
 * Each run creates and removes its own fixture under the checkout's .local directory.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MessageChannel } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteTranscriptSnapshotState } from "../../src/config/sessions/session-accessor.sqlite-read.js";
import type { LockedTranscriptCommitted } from "../../src/config/sessions/session-message-rewrite.worker.js";
import type { AgentWorkerOperationContext } from "../../src/state/openclaw-agent-operation-context.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "100" },
    sessions: { type: "string", default: "1000" },
    lengths: { type: "string", default: "100,1000,10000" },
    allocations: { type: "boolean", default: false },
  },
});
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, fallback: 100, min: 1, label });
const iterations = integer(values.iterations, "iterations");
const sessions = integer(values.sessions, "sessions");
const lengths = values.lengths.split(",").map((value) => integer(value, "length"));
const ownerUrl = new URL(
  "../../src/config/sessions/session-message-rewrite.worker.ts",
  import.meta.url,
);
let replaced = false;
if (values.owner) {
  const replacement = pathToFileURL(path.resolve(values.owner)).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl.href) {
        return nextLoad(url, context);
      }
      replaced = true;
      const loaded = nextLoad(replacement, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
}
const parent = path.resolve(".local");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, "transcript-locked-write-"));
const env = { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_HOME: root };
Object.assign(process.env, { OPENCLAW_STATE_DIR: root, OPENCLAW_HOME: root });
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot({
  logging: { level: "silent", consoleLevel: "silent", file: path.join(root, "run.log") },
});
const agent = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { replaceSessionEntryInDatabase } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-mutation.js");
const { replaceSqliteTranscriptEventsInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
const { readTranscriptEventRows } =
  await import("../../src/config/sessions/session-accessor.sqlite-read.js");
const { bindSqliteWorkerBackend } =
  await import("../../src/config/sessions/session-message-rewrite.worker.js");
const { runWithSqliteWorkerStateContext } =
  await import("../../src/infra/sqlite-worker-state-context.js");
const { createSqliteWorkerTransferCollector } =
  await import("../../src/infra/sqlite-worker-transfer.js");
const { withSqliteWorkerOperationAdmission } =
  await import("../../src/infra/sqlite-worker-operation-admission.js");
const { startSqliteStatementTiming } =
  await import("../../src/infra/database-engine/observation.js");
const { applySessionTurn } = await import("../../src/config/sessions/session-turn.worker.js");
const { readSessionTranscriptMaintenance } =
  await import("../../src/config/sessions/session-transcript-maintenance-read.js");
assert(!values.owner || replaced, "Baseline override did not load");
const sourceSha256 = hash("sha256", await readFile(values.owner ?? ownerUrl), "hex");
const digest = (value: unknown) => hash("sha256", JSON.stringify(value), "hex");
const { port1, port2 } = new MessageChannel();

try {
  await runWithSqliteWorkerStateContext({ environment: env }, async () => {
    const options = { agentId: "main", env, path: path.join(root, "agent.sqlite") };
    const database = agent.openOpenClawAgentDatabase(options);
    const scope = (sessionId: string) => ({
      agentId: "main",
      path: database.path,
      sessionKey: `agent:main:${sessionId}`,
      sessionId,
    });
    agent.runOpenClawAgentWriteTransaction(() => {
      for (let index = 0; index < sessions; index++) {
        replaceSessionEntryInDatabase(database, scope(`background-${index}`).sessionKey, {
          sessionId: `background-${index}`,
          updatedAt: 1,
          status: "done",
        });
      }
    }, options);
    let collector: ReturnType<typeof createSqliteWorkerTransferCollector> | undefined;
    const backend = bindSqliteWorkerBackend(
      { agentId: "main" },
      {
        database: database.db,
        databasePath: database.path,
        admit(stage, restriction) {
          restriction?.({ stage, facts: {} }, (request) => {
            const publication = isRecord(request.facts) ? request.facts.publication : undefined;
            if (isRecord(publication) && publication.transfer) {
              collector?.accept(publication.transfer);
            }
          });
        },
      },
    );
    for (const length of lengths) {
      const target = scope(`history-${length}`);
      agent.runOpenClawAgentWriteTransaction(() => {
        replaceSessionEntryInDatabase(database, target.sessionKey, {
          sessionId: target.sessionId,
          updatedAt: 1,
        });
        replaceSqliteTranscriptEventsInTransaction(
          database,
          target,
          [
            {
              type: "session",
              id: target.sessionId,
              version: 3,
              timestamp: "2026-10-01T00:00:00.000Z",
              cwd: "/synthetic",
            },
            ...Array.from({ length }, (_, index) => ({
              type: "message",
              id: `event-${index}`,
              parentId: index ? `event-${index - 1}` : null,
              timestamp: "2026-10-01T00:00:00.000Z",
              message: {
                role: index % 2 ? "assistant" : "user",
                content: `Synthetic ${index} `.padEnd(1024, "x"),
              },
            })),
          ],
          { rebuildProjectionSynchronously: true, scheduleProjectionReconcile: false },
        );
      }, options);
      let snapshot: SqliteTranscriptSnapshotState = {
        kind: "current",
        rows: readTranscriptEventRows(database, target.sessionId),
      };
      let sequence = 0;
      const append = () => {
        let committed: LockedTranscriptCommitted | undefined;
        collector = createSqliteWorkerTransferCollector("patch", (value) => {
          assert(isRecord(value) && value.kind === "session-transcript-locked");
          // The paired worker owns this private typed publication; framing validated its bytes.
          committed = value as LockedTranscriptCommitted;
        });
        const index = sequence++;
        withSqliteWorkerOperationAdmission({ port: port1 }, () =>
          backend.execute({
            type: "session.transcript.lock.commit",
            input: {
              kind: "message",
              scope: target,
              fence: {},
              sources: [],
              freshSources: [],
              freshAuthorityPrepared: true,
              sequenced: false,
              snapshot,
              options: {
                message: null,
                eventId: `appended-${index}`,
                now: 1_800_000_000_000 + index,
              },
              preparedMessageJson: JSON.stringify({
                role: "assistant",
                content: `Synthetic appended ${index}`,
              }),
            },
          }),
        );
        assert(
          collector.completed &&
            committed?.result?.appended &&
            committed.snapshot?.kind === "current",
        );
        snapshot = committed.snapshot;
        collector = undefined;
      };
      append();
      const sql = new Map<string, { id: string; sql: string; count: number; durationMs: number }>();
      const observe = (value: unknown) => {
        if (
          !isRecord(value) ||
          typeof value.sql !== "string" ||
          typeof value.durationMs !== "number"
        ) {
          return;
        }
        const entry = sql.get(value.sql) ?? {
          id: hash("sha256", value.sql, "hex").slice(0, 16),
          sql: value.sql,
          count: 0,
          durationMs: 0,
        };
        entry.count++;
        entry.durationMs += value.durationMs;
        sql.set(value.sql, entry);
      };
      const statements = channel("openclaw.database.statement");
      statements.subscribe(observe);
      const stop = startSqliteStatementTiming();
      try {
        append();
      } finally {
        statements.unsubscribe(observe);
      }
      const statementTiming = stop().summarize();
      globalThis.gc?.();
      await setImmediate();
      const gc: number[] = [];
      const gcByKind: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          gc.push(entry.duration);
          // This observer subscribes only to Node's GC performance entries.
          const detail: unknown = Reflect.get(entry, "detail");
          assert(isRecord(detail) && typeof detail.kind === "number");
          const kind = String(detail.kind);
          const bucket = (gcByKind[kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
          bucket.count++;
          bucket.totalMs += entry.duration;
          bucket.maxMs = Math.max(bucket.maxMs, entry.duration);
        }
      });
      observer.observe({ entryTypes: ["gc"] });
      const inspector = new Session();
      if (values.allocations) {
        await startCollectedHeapSampling(inspector, 4096);
      }
      const hostLoad = loadavg();
      const durations: number[] = [];
      const callbacks: number[] = [];
      const locks: number[] = [];
      const originalExec = database.db.exec.bind(database.db);
      let lockStarted: number | undefined;
      database.db.exec = (text: string) => {
        const command = text.trim().toUpperCase();
        const callbackMs =
          command === "COMMIT" && lockStarted !== undefined
            ? performance.now() - lockStarted
            : undefined;
        const result = originalExec(text);
        if (command === "BEGIN IMMEDIATE") {
          lockStarted = performance.now();
        } else if (callbackMs !== undefined && lockStarted !== undefined) {
          callbacks.push(callbackMs);
          locks.push(performance.now() - lockStarted);
          lockStarted = undefined;
        }
        return result;
      };
      const cpu = process.cpuUsage();
      const started = performance.now();
      try {
        for (let index = 0; index < iterations; index++) {
          const before = performance.now();
          append();
          durations.push(performance.now() - before);
        }
      } finally {
        database.db.exec = originalExec;
      }
      const elapsedMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      const allocationBytes = values.allocations
        ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      if (values.allocations) {
        inspector.disconnect();
      }
      await setImmediate();
      await setImmediate();
      observer.disconnect();
      assert(snapshot.kind === "current");
      const stored = readTranscriptEventRows(database, target.sessionId);
      assert.equal(digest(snapshot.rows), digest(stored));
      assert.equal(stored.length, length + 1 + sequence);
      const ordered = durations.toSorted((a, b) => a - b);
      const sortedCallbacks = callbacks.toSorted((a, b) => a - b);
      const sortedLocks = locks.toSorted((a, b) => a - b);
      assert.equal(
        locks.length,
        iterations,
        "Every measured append must own one write transaction",
      );
      console.log(
        JSON.stringify({
          operation: "session.transcript.locked-write",
          length,
          sessions,
          iterations,
          sourceSha256,
          elapsedMs,
          cpuMs: (used.user + used.system) / 1000,
          allocationBytes,
          latencyMs: {
            p50: ordered[Math.floor(iterations * 0.5)],
            p95: ordered[Math.floor(iterations * 0.95)],
            max: ordered.at(-1),
            samples: iterations,
          },
          callbackMs: {
            p50: sortedCallbacks[Math.floor(iterations * 0.5)],
            p95: sortedCallbacks[Math.floor(iterations * 0.95)],
            max: sortedCallbacks.at(-1),
            samples: callbacks.length,
          },
          writeLockMs: {
            p50: sortedLocks[Math.floor(iterations * 0.5)],
            p95: sortedLocks[Math.floor(iterations * 0.95)],
            max: sortedLocks.at(-1),
            samples: locks.length,
          },
          gcMs: gc.reduce((sum, duration) => sum + duration, 0),
          gcCount: gc.length,
          gcMaxMs: Math.max(0, ...gc),
          gcByKind,
          hostLoad,
          memory: process.memoryUsage(),
          contentSha256: digest(stored),
          statementTiming,
          statements: [...sql.values()],
        }),
      );
      if (!values.allocations) {
        for (const operation of [
          "sessions.transcript-maintenance",
          "session.transcript.append-turn",
        ] as const) {
          const holds: number[] = [];
          const context: AgentWorkerOperationContext = {
            options,
            open: () => database,
            admit() {},
            writeTransaction(operationLabel, _owner, write) {
              return agent.runOpenClawAgentWriteTransaction(
                () => {
                  const before = performance.now();
                  try {
                    return write(database);
                  } finally {
                    holds.push(performance.now() - before);
                  }
                },
                options,
                { operationLabel },
              );
            },
          };
          const measure = (index: number) => {
            if (operation === "sessions.transcript-maintenance") {
              const before = performance.now();
              const result = readSessionTranscriptMaintenance(
                database,
                { ...target, storePath: database.path },
                { operation: "version" },
              );
              holds.push(performance.now() - before);
              assert(result.version);
            } else {
              const result = applySessionTurn(
                {
                  agentId: "main",
                  sessionKey: target.sessionKey,
                  options: {
                    expectedSessionId: target.sessionId,
                    sessionFile: target.sessionKey,
                    messages: [
                      {
                        message: { role: "assistant", content: "Synthetic turn" },
                        eventId: `turn-${index}`,
                        now: 1_800_000_100_000 + index,
                      },
                    ],
                  },
                },
                context,
                (_database, candidate) => candidate,
              );
              assert(result.result.appendedMessages[0]?.appended);
            }
          };
          const beforeCpu = process.cpuUsage();
          const before = performance.now();
          for (let index = 0; index < iterations; index++) {
            measure(index);
          }
          const siblingElapsedMs = performance.now() - before;
          const siblingCpu = process.cpuUsage(beforeCpu);
          const sortedHolds = holds.toSorted((a, b) => a - b);
          sql.clear();
          statements.subscribe(observe);
          const stopSibling = startSqliteStatementTiming();
          try {
            measure(iterations);
          } finally {
            statements.unsubscribe(observe);
          }
          const siblingStatementTiming = stopSibling().summarize();
          console.log(
            JSON.stringify({
              operation,
              length,
              iterations,
              mode: operation === "sessions.transcript-maintenance" ? "read-version" : "write",
              elapsedMs: siblingElapsedMs,
              cpuMs: (siblingCpu.user + siblingCpu.system) / 1000,
              callbackMs: {
                p50: sortedHolds[Math.floor(iterations * 0.5)],
                p95: sortedHolds[Math.floor(iterations * 0.95)],
                max: sortedHolds.at(-1),
                samples: sortedHolds.length,
              },
              hostLoad: loadavg(),
              statementTiming: siblingStatementTiming,
              statements: [...sql.values()],
            }),
          );
        }
      }
    }
    backend.assertSettled?.();
    await backend.close();
  });
} finally {
  port1.close();
  port2.close();
  await agent.closeOpenClawAgentDatabasesAsync(root);
  await closeOpenClawStateDatabaseAsync();
  await rm(root, { recursive: true, force: true });
}
