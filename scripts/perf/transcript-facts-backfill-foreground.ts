/**
 * Synthetic real-actor/V2-worker contention proof; no real configs or accounts.
 * Prepare disjoint 160-session, 600-message cohorts with the companion Python
 * fixture helper, plus a finalized 49k path at synthetic-2 with historical facts
 * missing. This directly drives the maintenance owner; Gateway admission and
 * live-run scheduling are separate proof. Actor epochs verify natural eviction.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-backfill-foreground.ts \
 *   --fixture .local/facts/ten-million.sqlite --output .local/facts --label default
 *
 * Default order: four A/A pairs, then ABBA. A predeclared extra pair uses
 * --modes idle,backfill --arm-start 13 on newly prepared cohorts. For identical
 * per-arm snapshot copies, run one --modes arm per process; each uses cohort20000.
 * Slower diagnostic pacing uses
 * --pause-multiplier 2 or 4 on fresh cohorts. It never shortens owner delays.
 */
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SessionActorAuthority } from "../../src/config/sessions/session-actor-contract.js";
import { createSessionActorFactory } from "../../src/config/sessions/session-actor-durable.js";
import { createSessionTranscriptFactsBackfill } from "../../src/config/sessions/session-transcript-facts-backfill.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../src/state/openclaw-agent-db-lifecycle.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    output: { type: "string" },
    label: { type: "string" },
    modes: {
      type: "string",
      default: "idle,idle,idle,idle,idle,idle,idle,idle,idle,backfill,backfill,idle",
    },
    "arm-start": { type: "string", default: "0" },
    "pause-multiplier": { type: "string", default: "1" },
    samples: { type: "string", default: "1000" },
  },
});
assert(values.fixture && values.output && values.label);
assert(/^[a-z0-9-]+$/u.test(values.label));
const integer = (value: string) => {
  const result = Number(value);
  assert(Number.isSafeInteger(result) && result >= 0);
  return result;
};
const armStart = integer(values["arm-start"]);
const samples = integer(values.samples);
const multiplier = integer(values["pause-multiplier"]);
assert(samples > 0 && [1, 2, 4].includes(multiplier));
const modes = values.modes.split(",").map((mode) => {
  assert(mode === "idle" || mode === "backfill");
  return mode;
});
const fixture = path.resolve(values.fixture);
const output = path.resolve(values.output);
const localRoot = path.resolve(".local") + path.sep;
assert(fixture.startsWith(localRoot) && output.startsWith(localRoot));
assert(fs.lstatSync(fixture).isFile());
fs.mkdirSync(output, { recursive: true });
const prefix = path.join(output, values.label);
fs.writeFileSync(`${prefix}.pid`, `${process.pid}\n`, { flag: "wx" });
const emit = (value: unknown) => {
  fs.appendFileSync(`${prefix}.jsonl`, JSON.stringify(value) + "\n");
  console.log(JSON.stringify(value));
};
const statistics = (observations: number[]) => {
  const sorted = observations.toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p99: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)],
    max: sorted.at(-1),
  };
};
async function gate(arm: number, boundary: string) {
  const started = performance.now();
  const observations = [];
  for (;;) {
    const observation = {
      at: new Date().toISOString(),
      hostUptimeSeconds: os.uptime(),
      load: os.loadavg(),
    };
    observations.push(observation);
    if (observation.load[0]! <= 40) {
      return { waitMs: performance.now() - started, observations };
    }
    emit({ arm, boundary, waiting: true, ...observation });
    await pause(30_000);
  }
}
function countFacts() {
  const db = new DatabaseSync(fixture, { readOnly: true });
  try {
    return Number(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM session_transcript_active_event_facts WHERE session_id='synthetic-2'",
        )
        .get()?.n,
    );
  } finally {
    db.close();
  }
}
const diagnostic = channel("openclaw.agent-database.reservation");
const reports: unknown[] = [];
await withOpenClawTestState(
  { label: "transcript-facts-foreground", scenario: "minimal", applyEnv: true },
  async (state) => {
    const database = { agentId: "main", path: fixture, env: state.env };
    try {
      for (const [ordinal, mode] of modes.entries()) {
        const arm = armStart + ordinal;
        const startGate = await gate(arm, "before-arm");
        const first = 20000 + ordinal * 160;
        const startedAt = new Date().toISOString();
        let alive = true;
        const assertCurrent = () => assert(alive, "Synthetic actor authority must remain live");
        const lifetime = { assertCurrent, assertReadable: assertCurrent };
        const authority: SessionActorAuthority = {
          assertCurrent,
          authorize(_stage, facts) {
            assertCurrent();
            assert(facts.entry?.sessionId?.startsWith("synthetic-"));
          },
        };
        const factory = createSessionActorFactory(database);
        const acquire = (index: number) =>
          factory.acquire(
            { database: { kind: "file" }, sessionKey: `agent:main:synthetic-${index}` },
            lifetime,
          );
        const handles: Awaited<ReturnType<typeof acquire>>[] = [];
        const append: number[] = [],
          read: number[] = [],
          longRead: number[] = [],
          reservations: unknown[] = [],
          loads: number[][] = [];
        const epochs = new Map<number, string>();
        let changedAppendEpochs = 0,
          appendEpochComparisons = 0,
          changedReadEpochs = 0,
          readEpochComparisons = 0;
        let phase = "warmup";
        const observer = (message: unknown) => {
          if (phase !== "warmup") {
            reservations.push({ phase, at: performance.now(), message });
          }
        };
        const controller = new AbortController();
        const pauseController = new AbortController();
        const logs: string[] = [];
        const backfill = createSessionTranscriptFactsBackfill({
          database,
          assertCurrent,
          signal: controller.signal,
          log: {
            info(message) {
              logs.push(message);
              emit({ arm, message });
            },
            warn(message) {
              logs.push(message);
              emit({ arm, warning: message });
            },
          },
        });
        let background: Promise<void> = Promise.resolve();
        let backgroundError: Error | undefined;
        const ticks: { started: number; elapsedMs: number; complete: boolean; delayMs: number }[] =
          [];
        let measuredGate: Awaited<ReturnType<typeof gate>> | undefined;
        let measuredStart = 0,
          measuredCpu = process.cpuUsage(),
          measuredWallMs = 0,
          measuredCpuUsage = process.cpuUsage();
        const beforeFacts = countFacts();
        let measuredBeforeFacts = beforeFacts,
          measuredMidpointFacts = beforeFacts,
          measuredAfterFacts = beforeFacts;
        diagnostic.subscribe(observer);
        try {
          for (let index = 0; index < 160; index++) {
            handles.push(await acquire(first + index));
          }
          for (let iteration = 0; iteration < samples + 160; iteration++) {
            const measured = iteration >= 160;
            const index = iteration % 160;
            if (iteration === 160) {
              measuredGate = await gate(arm, "before-measurement");
              measuredBeforeFacts = countFacts();
              measuredStart = performance.now();
              measuredCpu = process.cpuUsage();
              if (mode === "backfill") {
                background = (async () => {
                  while (!pauseController.signal.aborted) {
                    const started = performance.now();
                    const receipt = await backfill.runBatch();
                    ticks.push({ started, elapsedMs: performance.now() - started, ...receipt });
                    if (receipt.complete || pauseController.signal.aborted) {
                      break;
                    }
                    await pause(receipt.delayMs * multiplier, undefined, {
                      signal: pauseController.signal,
                    }).catch((error: unknown) => {
                      if (!pauseController.signal.aborted) {
                        throw error;
                      }
                    });
                  }
                })().catch((error: unknown) => {
                  backgroundError =
                    error instanceof Error ? error : new Error("Backfill failed", { cause: error });
                });
              }
            }
            phase = measured ? "append" : "warmup";
            const appendStarted = performance.now();
            const handle = handles[index];
            assert(handle);
            const result = await handle.appendTranscriptEvent(
              {
                commandId: `foreground-${arm}-${iteration}`,
                phaseId: "synthetic",
                sessionId: `synthetic-${first + index}`,
                lifecycleRevision: null,
                eventJson: JSON.stringify({
                  type: "model_change",
                  id: `foreground-${iteration}`,
                  parentId: iteration < 160 ? "event-599" : `foreground-${iteration - 160}`,
                  timestamp: "2026-11-05T00:00:00.000Z",
                  provider: "synthetic",
                  modelId: "synthetic",
                }),
              },
              authority,
            );
            const appendElapsed = performance.now() - appendStarted;
            assert.equal(result.kind, "committed");
            if (measured) {
              append.push(appendElapsed);
            }
            if (result.kind === "committed") {
              const epoch = result.receipt.beforeVersion.epoch;
              const previous = epochs.get(index);
              if (measured && previous) {
                appendEpochComparisons++;
                changedAppendEpochs += Number(previous !== epoch);
              }
              epochs.set(index, epoch);
            }
            phase = measured ? "read" : "warmup";
            const readIndex = (index + 80) % 160;
            const reader = await acquire(first + readIndex);
            const readStarted = performance.now();
            try {
              const snapshot = await reader.read(authority);
              assert.equal(snapshot.entry?.sessionId, `synthetic-${first + readIndex}`);
              if (measured) {
                read.push(performance.now() - readStarted);
              }
              const previous = epochs.get(readIndex);
              if (measured && previous) {
                readEpochComparisons++;
                changedReadEpochs += Number(previous !== snapshot.version.epoch);
              }
              epochs.set(readIndex, snapshot.version.epoch);
            } finally {
              await reader.release();
            }
            if (iteration === 160 + Math.floor(samples / 2)) {
              measuredMidpointFacts = countFacts();
            }
            if (measured && iteration % 160 === 0) {
              phase = "long-read";
              const long = await acquire(2);
              const started = performance.now();
              try {
                const snapshot = await long.read(authority);
                assert.equal(snapshot.entry?.sessionId, "synthetic-2");
                longRead.push(performance.now() - started);
              } finally {
                await long.release();
              }
              loads.push(os.loadavg());
              emit({ arm, samples: append.length, ticks: ticks.length, load: loads.at(-1) });
            }
          }
          measuredWallMs = performance.now() - measuredStart;
          measuredCpuUsage = process.cpuUsage(measuredCpu);
          measuredAfterFacts = countFacts();
        } finally {
          // Let an accepted batch settle before closing; interrupt only the owned pause.
          pauseController.abort();
          await background;
          controller.abort();
          await backfill.close();
          diagnostic.unsubscribe(observer);
          for (const handle of handles) {
            await handle.release();
          }
          alive = false;
        }
        if (backgroundError !== undefined) {
          throw backgroundError;
        }
        const afterFacts = countFacts();
        const report = {
          arm,
          mode,
          first,
          samples,
          multiplier,
          startedAt,
          startGate,
          measuredGate,
          loads,
          measuredStarted: measuredStart,
          measuredEnded: measuredStart + measuredWallMs,
          measuredWallMs,
          measuredCpuUsage,
          append: statistics(append),
          read: statistics(read),
          longRead: statistics(longRead),
          longSession: "synthetic-2",
          longEvents: 49000,
          raw: { append, read, longRead },
          beforeFacts,
          afterFacts,
          measuredBeforeFacts,
          measuredMidpointFacts,
          measuredAfterFacts,
          ticks,
          changedAppendEpochs,
          appendEpochComparisons,
          changedReadEpochs,
          readEpochComparisons,
          logs,
          reservations,
        };
        reports.push(report);
        fs.writeFileSync(`${prefix}-${arm}.json`, JSON.stringify(report, null, 2) + "\n", {
          flag: "wx",
        });
        emit({ ...report, raw: undefined, reservations: reservations.length, ticks: ticks.length });
        if (mode === "backfill") {
          assert(
            measuredMidpointFacts > measuredBeforeFacts,
            "Background facts must advance during measured operations",
          );
          assert(afterFacts < 49000, "Background must not reach future foreground cohorts");
        }
        assert(
          changedAppendEpochs >= appendEpochComparisons * 0.9,
          "Natural eviction must prove nonresident append preimages",
        );
        assert(
          changedReadEpochs >= readEpochComparisons * 0.9,
          "Fresh replicas and eviction must prove nonresident reads",
        );
      }
    } finally {
      await closeOpenClawAgentDatabasesAsync(path.dirname(fixture));
      closeOpenClawAgentDatabasesForTest(path.dirname(fixture));
    }
  },
);
fs.writeFileSync(`${prefix}.json`, JSON.stringify(reports, null, 2) + "\n", { flag: "wx" });
