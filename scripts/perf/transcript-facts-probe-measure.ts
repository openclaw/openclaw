/** Real scheduler/actor contention on a synthetic active-facts fixture; see transcript-facts-backfill.md. */
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { writeSessionEntry } from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventsInTransaction } from "../../src/config/sessions/session-accessor.sqlite-transcript-store.js";
import { createSessionActorFactory } from "../../src/config/sessions/session-actor-durable.js";
import { createSessionTranscriptFactsBackfill } from "../../src/config/sessions/session-transcript-facts-backfill.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.js";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    output: { type: "string" },
    samples: { type: "string", default: "1000" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.fixture && values.output);
const fixture = path.resolve(values.fixture);
const output = path.resolve(values.output);
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(fixture.includes(`${path.sep}.local${path.sep}`));
assert(fs.lstatSync(fixture).isFile() && fs.statSync(fixture).size > 0);
assert(!fs.existsSync(output));
const summarize = (input: number[]) => {
  const sorted = input.toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    p99: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)],
    max: sorted.at(-1),
  };
};
await withOpenClawTestState(
  { label: "facts-probe-measure", scenario: "minimal", applyEnv: true },
  async ({ env }) => {
    const database = { agentId: "main", path: fixture, env };
    const scope = {
      ...database,
      sessionId: "synthetic-foreground",
      sessionKey: "agent:main:synthetic-foreground",
    };
    runOpenClawAgentWriteTransaction((db) => {
      writeSessionEntry(db, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
      appendTranscriptEventsInTransaction(db, scope, [
        {
          type: "session",
          version: 3,
          id: scope.sessionId,
          timestamp: "2026-11-05T00:00:00.000Z",
          cwd: "/synthetic",
        },
      ]);
    }, database);
    const controller = new AbortController();
    const assertCurrent = () => controller.signal.throwIfAborted();
    const authority = { assertCurrent, authorize: assertCurrent };
    const actor = await createSessionActorFactory(database).acquire(
      { database: { kind: "file" }, sessionKey: scope.sessionKey },
      { assertCurrent, assertReadable: assertCurrent },
    );
    let lastId: string | null = null;
    const append = async (index: number) => {
      const id = `foreground-${index}`;
      const result = await actor.appendTranscriptEvent(
        {
          commandId: id,
          phaseId: "synthetic",
          sessionId: scope.sessionId,
          lifecycleRevision: null,
          eventJson: JSON.stringify({
            type: "model_change",
            id,
            parentId: lastId,
            timestamp: "2026-11-05T00:00:00.000Z",
            provider: "synthetic",
            modelId: "synthetic",
          }),
        },
        authority,
      );
      assert.equal(result.kind, "committed", JSON.stringify(result));
      lastId = id;
    };
    const reservations: Record<string, unknown>[] = [];
    const observe = (message: unknown) => {
      if (isRecord(message)) {
        reservations.push(message);
      }
    };
    const diagnostic = channel("openclaw.agent-database.reservation");
    const ticks: { elapsedMs: number; delayMs: number; complete: boolean }[] = [];
    const logs: string[] = [];
    const backfill = createSessionTranscriptFactsBackfill({
      database,
      assertCurrent,
      signal: controller.signal,
      log: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
    });
    const pacing = new AbortController();
    const inspector = new Session();
    let background: Promise<void> = Promise.resolve();
    let backgroundError: Error | undefined;
    try {
      for (let i = 0; i < 20; i++) {
        await append(i);
      }
      // Warm reader/writer transport separately from the measured restart pass.
      await backfill.runBatch();
      await backfill.runBatch();
      await backfill.close();
      const measured = createSessionTranscriptFactsBackfill({
        database,
        assertCurrent,
        signal: controller.signal,
        log: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
      });
      const hostLoad = os.loadavg();
      assert(hostLoad[0]! < 40, "Host too busy for a measured arm");
      if (values.allocations) {
        await startCollectedHeapSampling(inspector, 32768);
      }
      diagnostic.subscribe(observe);
      const cpu = process.cpuUsage();
      const started = performance.now();
      background = (async () => {
        while (!pacing.signal.aborted) {
          const tick = performance.now();
          const result = await measured.runBatch();
          ticks.push({ elapsedMs: performance.now() - tick, ...result });
          if (result.complete) {
            break;
          }
          await pause(result.delayMs, undefined, { signal: pacing.signal });
        }
      })().catch((error: unknown) => {
        if (!(pacing.signal.aborted && error instanceof Error && error.name === "AbortError")) {
          backgroundError =
            error instanceof Error ? error : new Error("Backfill failed", { cause: error });
        }
      });
      const latencies: number[] = [];
      try {
        for (let i = 20; i < samples + 20; i++) {
          const tick = performance.now();
          await append(i);
          latencies.push(performance.now() - tick);
          await pause(1);
        }
      } finally {
        pacing.abort();
        await background;
        await measured.close();
      }
      const wallMs = performance.now() - started;
      const usage = process.cpuUsage(cpu);
      diagnostic.unsubscribe(observe);
      let allocationBytes: number | undefined;
      if (values.allocations) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        allocationBytes = sumSampledHeapBytes(profile.head);
      }
      if (backgroundError) {
        throw backgroundError;
      }
      assert(ticks.length > 1, "Measurement must include coverage probes after discovery");
      const appends = reservations.filter(
        (row) =>
          Array.isArray(row.workerOperations) &&
          row.workerOperations.includes("session.actor.appendTranscriptEvent"),
      );
      assert.equal(appends.length, samples);
      const probes = reservations.filter(
        (row) => Array.isArray(row.workerOperations) && row.workerOperations.includes("probe"),
      );
      const report = {
        fixtureBytes: fs.statSync(fixture).size,
        hostLoad,
        endLoad: os.loadavg(),
        samples,
        wallMs,
        cpuMs: (usage.user + usage.system) / 1000,
        allocationBytes,
        appendMs: summarize(latencies),
        queueWaitMs: summarize(appends.map((row) => Number(row.queueWaitMs))),
        probeReservations: probes.length,
        probeWriterMs: probes.reduce((sum, row) => sum + Number(row.writerExecutionMs), 0),
        ticks,
        logs,
        reservations,
      };
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
      console.log(
        JSON.stringify({
          ...report,
          ticks: ticks.length,
          logs: undefined,
          reservations: undefined,
        }),
      );
    } finally {
      pacing.abort();
      await background;
      diagnostic.unsubscribe(observe);
      inspector.disconnect();
      await backfill.close();
      await actor.release();
      controller.abort();
      await closeOpenClawAgentDatabasesAsync();
    }
  },
);
