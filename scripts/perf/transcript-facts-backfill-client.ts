/**
 * Isolate real V2 client lifecycle CPU from a fixed covered-tail backfill command.
 * Use only an isolated synthetic agent DB under this checkout's .local directory.
 * A fresh test-state owner supplies and removes all config/state; real configs are
 * never selected. Finally closes only this process's fixture-root DB resources.
 * The cursor must leave exactly one already-covered active row. The unmeasured
 * warm-up may derive that last fact through the production worker helper.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-backfill-client.ts \
 *   --fixture .local/facts-backfill/ten-million.sqlite --session synthetic-2 \
 *   --after-position 48998 --output .local/facts-backfill --label client-cost
 *
 * Records one A/A pair, AB/BA timing pairs (1,000 calls/arm), and separate sampled
 * host-allocation AB/BA pairs. Process CPU includes Worker threads; thread CPU and
 * heap sampling cover the host. --control-pairs 4 --iterations 10000 lengthens
 * untraced qualification when the initial short A/A controls show noise.
 * This isolates open/close overhead, not payload
 * batch cost, pacing, Gateway scheduling, or a claim of SQLite reopening.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { TranscriptActiveFactsBackfillOperations } from "../../src/config/sessions/session-transcript-active-facts-backfill.worker.js";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../src/state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentSqliteWorkerStoreV2 } from "../../src/state/openclaw-agent-worker-store.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.js";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    output: { type: "string" },
    label: { type: "string" },
    session: { type: "string", default: "synthetic-2" },
    "after-position": { type: "string" },
    iterations: { type: "string", default: "1000" },
    "control-pairs": { type: "string", default: "1" },
    "allocation-iterations": { type: "string", default: "1000" },
  },
});
assert(values.fixture && values.output && values.label && values["after-position"]);
assert(/^[a-z0-9-]+$/u.test(values.label));
assert(/^synthetic-\d+$/u.test(values.session));
const integer = (value: string) => {
  const n = Number(value);
  assert(Number.isSafeInteger(n) && n >= 0);
  return n;
};
const iterations = integer(values.iterations);
const controlPairs = integer(values["control-pairs"]);
const allocationIterations = integer(values["allocation-iterations"]);
assert(iterations > 0);
const fixture = path.resolve(values.fixture);
const output = path.resolve(values.output);
const localRoot = path.resolve(".local") + path.sep;
assert(fixture.startsWith(localRoot) && output.startsWith(localRoot));
assert(fs.lstatSync(fixture).isFile());
const fixtureName = path.basename(fixture, ".sqlite");
const fixtureReport = z
  .object({
    name: z.string(),
    finalization: z.object({
      sessions: z.array(
        z.object({ session_id: z.string(), rows_rewritten: z.number().int().positive() }),
      ),
    }),
  })
  .parse(
    JSON.parse(
      fs.readFileSync(path.join(path.dirname(fixture), `${fixtureName}-fixture.json`), "utf8"),
    ),
  );
assert.equal(fixtureReport.name, fixtureName);
const selected = fixtureReport.finalization.sessions.find(
  (session) => session.session_id === values.session,
);
assert(selected, "The selected synthetic path must have finalized identities");
assert.equal(
  integer(values["after-position"]) + 2,
  selected.rows_rewritten,
  "The cursor must leave one finalized tail row",
);
fs.mkdirSync(output, { recursive: true });
const prefix = path.join(output, values.label);
fs.writeFileSync(`${prefix}.pid`, `${process.pid}\n`, { flag: "wx" });
const records: unknown[] = [];
const emit = (value: unknown) => {
  records.push(value);
  fs.appendFileSync(`${prefix}.jsonl`, `${JSON.stringify(value)}\n`);
};
const command = {
  type: "batch" as const,
  input: { sessionId: values.session, afterPosition: integer(values["after-position"]) },
};
const valid = (result: TranscriptActiveFactsBackfillOperations["batch"]["output"]) => {
  assert(result.done && !result.busy && !result.unavailable);
  assert.equal(result.rowsVisited, 1);
  assert.equal(result.rowsSkipped, 0);
  assert.equal(result.rowsFilled, 0);
  assert.equal(result.bytesRead, 0);
};
async function gate(label: string) {
  for (;;) {
    const load = os.loadavg();
    if (load[0]! <= 40) {
      return load;
    }
    emit({ kind: "wait", label, load, at: Date.now() });
    await pause(30_000);
  }
}
const millis = (usage: NodeJS.CpuUsage) => (usage.user + usage.system) / 1000;

await withOpenClawTestState(
  { label: "transcript-facts-client", scenario: "minimal", applyEnv: true },
  async (state) => {
    const controller = new AbortController();
    const assertCurrent = () => controller.signal.throwIfAborted();
    const database = { agentId: "main", path: fixture, env: state.env };
    const open = () =>
      openOpenClawAgentSqliteWorkerStoreV2<TranscriptActiveFactsBackfillOperations>(
        database,
        { version: 2, assertCurrent },
        {
          moduleUrl: resolveRuntimeWorkerUrl(
            runtimeProcessEntrypoints.sessionTranscriptActiveFactsBackfill,
          ),
          input: undefined,
          priority: "background",
        },
      );
    const options = { signal: controller.signal };
    try {
      await gate("warmup");
      const warm = await open();
      try {
        await warm.prepare(options);
        const seeded = await warm.execute(command, assertCurrent, options);
        assert(seeded.done && seeded.rowsVisited === 1 && seeded.rowsSkipped === 0);
        for (let i = 0; i < 50; i++) {
          valid(await warm.execute(command, assertCurrent, options));
        }
      } finally {
        await warm.close();
      }
      type Mode = "reopen" | "retain";
      const run = async (mode: Mode, count: number, label: string, allocation: boolean) => {
        const load = await gate(label);
        const inspector = allocation ? new Session() : undefined;
        try {
          if (inspector) {
            await startCollectedHeapSampling(inspector, 32768);
          }
          const processStart = process.cpuUsage();
          const threadStart = process.threadCpuUsage();
          const started = performance.now();
          let retained: Awaited<ReturnType<typeof open>> | undefined;
          try {
            if (mode === "retain") {
              retained = await open();
            }
            for (let i = 0; i < count; i++) {
              const client = retained ?? (await open());
              try {
                valid(await client.execute(command, assertCurrent, options));
              } finally {
                if (!retained) {
                  await client.close();
                }
              }
            }
          } finally {
            await retained?.close();
          }
          const wallMs = performance.now() - started;
          const processCpuMs = millis(process.cpuUsage(processStart));
          const hostThreadCpuMs = millis(process.threadCpuUsage(threadStart));
          let hostAllocationBytes: number | undefined;
          if (inspector) {
            const { profile } = await inspector.post("HeapProfiler.stopSampling");
            hostAllocationBytes = sumSampledHeapBytes(profile.head);
          }
          emit({
            kind: allocation ? "allocation" : "timing",
            label,
            mode,
            iterations: count,
            rowsVisited: count,
            rowsFilled: 0,
            wallMs,
            processCpuMs,
            hostThreadCpuMs,
            hostAllocationBytes,
            wallMsPerBatch: wallMs / count,
            processCpuMsPerBatch: processCpuMs / count,
            hostThreadCpuMsPerBatch: hostThreadCpuMs / count,
            hostAllocationBytesPerBatch:
              hostAllocationBytes === undefined ? undefined : hostAllocationBytes / count,
            startLoad: load,
            endLoad: os.loadavg(),
            memory: process.memoryUsage(),
          });
        } finally {
          inspector?.disconnect();
        }
      };
      for (let pair = 0; pair < controlPairs; pair++) {
        await run("reopen", iterations, `aa-${pair}-0`, false);
        await run("reopen", iterations, `aa-${pair}-1`, false);
      }
      await run("reopen", iterations, "ab-base", false);
      await run("retain", iterations, "ab-candidate", false);
      await run("retain", iterations, "ba-candidate", false);
      await run("reopen", iterations, "ba-base", false);
      if (allocationIterations > 0) {
        await run("reopen", allocationIterations, "allocation-ab-base", true);
        await run("retain", allocationIterations, "allocation-ab-candidate", true);
        await run("retain", allocationIterations, "allocation-ba-candidate", true);
        await run("reopen", allocationIterations, "allocation-ba-base", true);
      }
      const load = await gate("open-close-only");
      const processStart = process.cpuUsage();
      const threadStart = process.threadCpuUsage();
      const started = performance.now();
      for (let i = 0; i < iterations; i++) {
        const client = await open();
        await client.close();
      }
      emit({
        kind: "open-close-only",
        iterations,
        wallMs: performance.now() - started,
        processCpuMs: millis(process.cpuUsage(processStart)),
        hostThreadCpuMs: millis(process.threadCpuUsage(threadStart)),
        startLoad: load,
        endLoad: os.loadavg(),
      });
    } finally {
      controller.abort();
      await closeOpenClawAgentDatabasesAsync(path.dirname(fixture));
      closeOpenClawAgentDatabasesForTest(path.dirname(fixture));
    }
  },
);
fs.writeFileSync(
  `${prefix}.json`,
  `${JSON.stringify({ fixture, command, node: process.version, records }, null, 2)}\n`,
  { flag: "wx" },
);
console.log(JSON.stringify({ output: `${prefix}.json`, records: records.length }));
