/**
 * Append-turn CPU/allocation and write-lock hold versus interleaved transcript history.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-append-turn-measure.ts
 *   --iterations 1000 --sessions 100 --lengths 100,1000,10000 [--allocations]
 *   [--owner /absolute/base-directory]
 * The optional directory contains original transcript-append-parent.ts and
 * session-accessor.sqlite-transcript-parent.ts; both load at their original URLs.
 * Alternate base/candidate processes; collect allocation in separate sampled passes.
 * Each measured applySessionTurn executes its real write transaction, then rolls
 * back to preserve the same leaf/parent input for every iteration. A separate final
 * commit verifies exact transcript bytes. Thus these are rollback hold measurements,
 * not durable commit latency or whole-Gateway throughput. Synthetic host grants only.
 * Linear implicit-tail turns are the control; explicit-parent turns after a dangling
 * leaf exercise the redundant navigation scan. Fixture setup, SQL tracing and digests
 * are outside timing. Accept matching stored bytes with lower CPU/allocation and no
 * material adverse control result. Per-kind GC/maxima and host load are context.
 * Fixtures are interleaved in 100-event chunks with unrelated session writes, under
 * this checkout's .local, and removed on completion. No production state is read.
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
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import type { AgentWorkerOperationContext } from "../../src/state/openclaw-agent-operation-context.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "1000" },
    sessions: { type: "string", default: "100" },
    lengths: { type: "string", default: "100,1000,10000" },
    allocations: { type: "boolean", default: false },
  },
});
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, fallback: 100, min: 1, label });
const iterations = integer(values.iterations, "iterations");
const sessions = integer(values.sessions, "sessions");
const lengths = values.lengths.split(",").map((value) => integer(value, "length"));
const owners = ["transcript-append-parent.ts", "session-accessor.sqlite-transcript-parent.ts"];
const replacements = new Map(
  owners.map((name) => [
    new URL(`../../src/config/sessions/${name}`, import.meta.url).href,
    values.owner ? pathToFileURL(path.resolve(values.owner, name)).href : undefined,
  ]),
);
const loadedOwners = new Set<string>();
if (values.owner) {
  registerHooks({
    load(url, context, nextLoad) {
      const replacement = replacements.get(url);
      if (!replacement) {
        return nextLoad(url, context);
      }
      loadedOwners.add(url);
      const loaded = nextLoad(replacement, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
}
const sourceSha256 = hash(
  "sha256",
  (
    await Promise.all(
      [...replacements].map(([url, replacement]) => readFile(new URL(replacement ?? url), "utf8")),
    )
  ).join("\n"),
  "hex",
);
const parent = path.resolve(".local");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, "transcript-append-turn-"));
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
const { appendTranscriptEventsInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
const { readTranscriptEventRows } =
  await import("../../src/config/sessions/session-accessor.sqlite-read.js");
const { applySessionTurn } = await import("../../src/config/sessions/session-turn.worker.js");
const { runWithSqliteWorkerStateContext } =
  await import("../../src/infra/sqlite-worker-state-context.js");
const { startSqliteStatementTiming } =
  await import("../../src/infra/database-engine/observation.js");
assert(!values.owner || loadedOwners.size === owners.length, "Baseline owners did not both load");
const digest = (value: unknown) => hash("sha256", JSON.stringify(value), "hex");
const timestamp = "2026-10-01T00:00:00.000Z";
const summary = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted.at(-1),
    samples: sorted.length,
  };
};

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
    const seed = (target: ReturnType<typeof scope>, events: TranscriptEvent[]) =>
      agent.runOpenClawAgentWriteTransaction(
        () =>
          appendTranscriptEventsInTransaction(database, target, events, {
            scheduleProjectionReconcile: false,
          }),
        options,
      );
    const create = (target: ReturnType<typeof scope>) => {
      agent.runOpenClawAgentWriteTransaction(
        () =>
          replaceSessionEntryInDatabase(database, target.sessionKey, {
            sessionId: target.sessionId,
            updatedAt: 1,
          }),
        options,
      );
      seed(target, [
        { type: "session", version: 3, id: target.sessionId, timestamp, cwd: "/synthetic" },
      ]);
    };
    const backgrounds = Array.from({ length: sessions }, (_, index) =>
      scope(`background-${index}`),
    );
    for (const background of backgrounds) {
      create(background);
    }
    for (const length of lengths) {
      for (const shape of ["linear-implicit", "dangling-leaf-explicit"] as const) {
        const target = scope(`${shape}-${length}`);
        create(target);
        const expected: TranscriptEvent[] = [
          { type: "session", version: 3, id: target.sessionId, timestamp, cwd: "/synthetic" },
        ];
        for (let offset = 0; offset < length; offset += 100) {
          const events = Array.from({ length: Math.min(100, length - offset) }, (_, index) => ({
            type: "message",
            id: `event-${offset + index}`,
            parentId: offset + index ? `event-${offset + index - 1}` : null,
            timestamp,
            message: {
              role: (offset + index) % 2 ? "assistant" : "user",
              content: `Synthetic ${offset + index} `.padEnd(1024, "x"),
            },
          }));
          seed(target, events);
          expected.push(...events);
          const background = backgrounds[(offset / 100) % backgrounds.length]!;
          seed(background, [
            {
              type: "message",
              id: `${shape}-${length}-${offset}`,
              parentId: null,
              timestamp,
              message: { role: "assistant", content: "Unrelated synthetic history" },
            },
          ]);
        }
        if (shape === "dangling-leaf-explicit") {
          const leaf = {
            type: "leaf",
            id: "dangling-leaf",
            parentId: `event-${length - 1}`,
            targetId: "missing",
            timestamp,
          };
          seed(target, [leaf]);
          expected.push(leaf);
        }
        const original = readTranscriptEventRows(database, target.sessionId);
        assert.equal(
          digest(original.map(({ eventJson }) => JSON.parse(eventJson))),
          digest(expected),
        );
        const rollback = new Error("Synthetic benchmark rollback");
        let shouldRollback = true;
        const callbacks: number[] = [];
        const context: AgentWorkerOperationContext = {
          options,
          open: () => database,
          admit() {},
          writeTransaction<T>(
            operationLabel: string,
            _owner: string,
            write: (current: typeof database) => T,
            diagnosticContext?: Parameters<AgentWorkerOperationContext["writeTransaction"]>[3],
          ) {
            let result: { value: T } | undefined;
            try {
              agent.runOpenClawAgentWriteTransaction(
                () => {
                  const before = performance.now();
                  try {
                    result = { value: write(database) };
                  } finally {
                    callbacks.push(performance.now() - before);
                  }
                  if (shouldRollback) {
                    throw rollback;
                  }
                },
                options,
                { operationLabel, diagnosticContext },
              );
            } catch (error) {
              if (error !== rollback) {
                throw error;
              }
            }
            assert(result, "Turn did not return its candidate before rollback");
            return result.value;
          },
        };
        const effectiveParentId = `event-${length - 1}`;
        const append = () => {
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
                    eventId: "measured-turn",
                    now: 1_800_000_100_000,
                    ...(shape === "dangling-leaf-explicit" ? { parentId: effectiveParentId } : {}),
                  },
                ],
              },
            },
            context,
            (_database, candidate) => candidate.result,
          );
          assert.equal(result.appendedMessages[0]?.appended, true);
          assert.equal(result.appendedMessages[0]?.effectiveParentId, effectiveParentId);
        };
        for (let warmup = 0; warmup < 10; warmup++) {
          append();
        }
        const sql = new Map<
          string,
          { id: string; sql: string; count: number; durationMs: number }
        >();
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
        callbacks.length = 0;
        globalThis.gc?.();
        await setImmediate();
        const gcByKind: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const detail: unknown = Reflect.get(entry, "detail");
            assert(isRecord(detail) && typeof detail.kind === "number");
            const bucket = (gcByKind[String(detail.kind)] ??= { count: 0, totalMs: 0, maxMs: 0 });
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
        const locks: number[] = [];
        const originalExec = database.db.exec.bind(database.db);
        let lockStarted: number | undefined;
        database.db.exec = (text: string) => {
          const command = text.trim().toUpperCase();
          const result = originalExec(text);
          if (command === "BEGIN IMMEDIATE") {
            lockStarted = performance.now();
          } else if (command === "ROLLBACK" && lockStarted !== undefined) {
            locks.push(performance.now() - lockStarted);
            lockStarted = undefined;
          }
          return result;
        };
        const hostLoad = loadavg();
        const cpu = process.cpuUsage();
        const started = performance.now();
        try {
          for (let index = 0; index < iterations; index++) {
            append();
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
        assert.equal(
          locks.length,
          iterations,
          "Each measured turn must own one rolled-back write transaction",
        );
        assert.equal(callbacks.length, iterations);
        assert.equal(digest(readTranscriptEventRows(database, target.sessionId)), digest(original));
        const callbackMs = summary(callbacks);
        shouldRollback = false;
        append();
        const committed = readTranscriptEventRows(database, target.sessionId);
        assert.deepEqual(committed.slice(0, -1), original);
        assert.equal(committed.length, original.length + 1);
        assert.deepEqual(JSON.parse(committed.at(-1)!.eventJson), {
          type: "message",
          id: "measured-turn",
          parentId: effectiveParentId,
          timestamp: new Date(1_800_000_100_000).toISOString(),
          message: { role: "assistant", content: "Synthetic turn" },
        });
        console.log(
          JSON.stringify({
            operation: "session.transcript.append-turn",
            shape,
            length,
            sessions,
            iterations,
            mode: "rollback",
            sourceSha256,
            elapsedMs,
            cpuMs: (used.user + used.system) / 1000,
            allocationBytes,
            callbackMs,
            writeLockMs: summary(locks),
            gcByKind,
            hostLoad,
            memory: process.memoryUsage(),
            contentSha256: digest(committed),
            statementTiming,
            statements: [...sql.values()],
          }),
        );
      }
    }
  });
} finally {
  await agent.closeOpenClawAgentDatabasesAsync(root);
  await closeOpenClawStateDatabaseAsync();
  await rm(root, { recursive: true, force: true });
}
