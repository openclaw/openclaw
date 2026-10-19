import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { summarizeBenchmarkTimings } from "./benchmark-harness.mts";

export type UtilityBenchmarkWorkload =
  | "decision-transport"
  | "progress-narration"
  | "isolated-completion";

export function parseUtilityBenchmarkWorkload(value: string): UtilityBenchmarkWorkload {
  assert(
    value === "decision-transport" ||
      value === "progress-narration" ||
      value === "isolated-completion",
    "Unknown benchmark workload",
  );
  return value;
}

export const utilityBenchmarkSources = {
  "decision-transport": {
    entry: "scripts/bench-decision-transport-worker.ts",
    fixtures: [],
  },
  "progress-narration": {
    entry: "scripts/bench-progress-narration-worker.ts",
    fixtures: ["scripts/lib/bench-narration-model.ts"],
  },
  "isolated-completion": {
    entry: "scripts/bench-isolated-completion-worker.ts",
    fixtures: [],
  },
} as const;

/** The synchronous worker must have exited before its fresh state is removed. */
export function withUtilityBenchmarkEnvironment<T>(
  workload: UtilityBenchmarkWorkload,
  run: (env: NodeJS.ProcessEnv) => T,
): T {
  if (workload !== "isolated-completion") {
    return run(process.env);
  }
  // openclaw-temp-dir: allow process-owned fixture removed after synchronous child exit
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-isolated-bench-")));
  try {
    const stateDir = join(root, "state");
    mkdirSync(join(root, "workspace"));
    mkdirSync(join(stateDir, "agents", "main", "agent"), { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "TZ"]) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
    return run({
      ...env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
      NODE_NO_WARNINGS: "1",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function nonNegative(value: unknown): number {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0);
  return value;
}

function memory(value: unknown) {
  assert(isRecord(value), "Missing memory snapshot");
  return Object.fromEntries(
    ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"].map((key) => [
      key,
      nonNegative(value[key]),
    ]),
  );
}

function parseTransportSample(value: unknown, requests: number) {
  assert(isRecord(value), "Missing worker result");
  assert.equal(value.workload, "decision-transport");
  assert.equal(value.requests, requests);
  assert.equal(value.socketsAfterPoolClose, 0);
  assert(Array.isArray(value.warmTimingsMs));
  assert.equal(value.warmTimingsMs.length, requests - 1);
  const connections = nonNegative(value.connections);
  assert(Number.isInteger(connections) && connections >= 1 && connections <= requests);
  return {
    requests,
    connections,
    responseBytes: nonNegative(value.responseBytes),
    firstEvaluationMs: nonNegative(value.firstEvaluationMs),
    warmTimingsMs: value.warmTimingsMs.map(nonNegative),
    cpuMs: nonNegative(value.cpuMs),
    peakRssBytes: nonNegative(value.peakRssBytes),
    memoryBefore: memory(value.memoryBefore),
    memoryAfter: memory(value.memoryAfter),
    memoryAfterDrain: memory(value.memoryAfterDrain),
    idleSocketsBeforeTeardown: nonNegative(value.idleSocketsBeforeTeardown),
    socketsAfterPoolClose: 0,
  };
}

function parseNarrationSample(value: unknown) {
  assert(isRecord(value) && Array.isArray(value.scenarios), "Missing narration scenarios");
  assert.equal(value.workload, "progress-narration");
  const names = ["burst", "quiet-tail", "urgent", "stop", "abort", "next-turn"];
  assert.equal(value.scenarios.length, names.length);
  return {
    scenarios: value.scenarios.map((row: unknown, index: number) => {
      assert(isRecord(row));
      assert.equal(row.scenario, names[index]);
      assert.equal(row.offered, index === 0 ? 41 : 2);
      assert.equal(row.forwarded, row.offered);
      assert.equal(row.maxInFlight, 1);
      assert.equal(row.generationsAfterStop, 0);
      assert.equal(row.updatesAfterStop, 0);
      assert.equal(typeof row.foregroundCompletedWhileBlocked, "boolean");
      assert(Array.isArray(row.inputs) && row.inputs.length >= 1 && row.inputs.length <= 30);
      assert.equal(row.generations, row.inputs.length);
      const inputs = row.inputs.map((input: unknown) => {
        assert(isRecord(input));
        assert(typeof input.userMessage === "string" && typeof input.previousText === "string");
        assert(Array.isArray(input.activityNotes));
        return {
          userMessage: input.userMessage,
          previousText: input.previousText,
          activityNotes: input.activityNotes.map((note: unknown) => {
            assert(typeof note === "string");
            return note;
          }),
          simulatedAtMs: nonNegative(input.simulatedAtMs),
        };
      });
      assert(Array.isArray(row.updates));
      const updates = row.updates.map((update: unknown) => {
        assert(isRecord(update) && typeof update.text === "string");
        return { text: update.text, simulatedAtMs: nonNegative(update.simulatedAtMs) };
      });
      return {
        scenario: names[index]!,
        offered: index === 0 ? 41 : 2,
        forwarded: row.forwarded,
        preparations: nonNegative(row.preparations),
        generations: inputs.length,
        maxInFlight: 1,
        foregroundCompletedWhileBlocked: row.foregroundCompletedWhileBlocked,
        inputs,
        updates,
        generationsAfterStop: 0,
        updatesAfterStop: 0,
      };
    }),
  };
}

export const transportWorkload = {
  name: "decision-transport" as const,
  scope: "instrumented component; no model inference, TLS or Gateway startup claims",
  initialization: "firstEvaluationMs and cpuMs include lazy client/validator initialization",
  validate: parseTransportSample,
  summarize: (rows: ReturnType<typeof parseTransportSample>[]) => ({
    connectionsPerSample: summarizeBenchmarkTimings(rows.map((row) => row.connections)),
    firstEvaluationMs: summarizeBenchmarkTimings(rows.map((row) => row.firstEvaluationMs)),
    warmSampleMedianMs: summarizeBenchmarkTimings(
      rows.map((row) => summarizeBenchmarkTimings(row.warmTimingsMs).p50),
    ),
    cpuMs: summarizeBenchmarkTimings(rows.map((row) => row.cpuMs)),
    peakRssBytes: summarizeBenchmarkTimings(rows.map((row) => row.peakRssBytes)),
  }),
};

export const narrationWorkload = {
  name: "progress-narration" as const,
  scope:
    "real narrator with a synthetic model boundary; counts and simulated cadence only, no latency, CPU, RSS, token or inference-cost claims",
  initialization:
    "model preparation and generation are replaced; actual utility inference is not exercised",
  validate: parseNarrationSample,
  summarize: (rows: ReturnType<typeof parseNarrationSample>[]) => {
    // This schedule is deterministic. Divergent replicas invalidate work counts.
    for (const row of rows) {
      assert.deepEqual(row, rows[0], "Narration replicas differ");
    }
    return rows[0]!.scenarios.map((row) => ({
      scenario: row.scenario,
      offered: row.offered,
      forwarded: row.forwarded,
      preparations: row.preparations,
      generations: row.generations,
      updates: row.updates.length,
      maxInFlight: row.maxInFlight,
      simulatedDispatchMs: row.inputs.map((input) => input.simulatedAtMs),
      lastActivityNotes: row.inputs.at(-1)!.activityNotes,
      foregroundCompletedWhileBlocked: row.foregroundCompletedWhileBlocked,
      generationsAfterStop: row.generationsAfterStop,
      updatesAfterStop: row.updatesAfterStop,
    }));
  },
};

function parseIsolatedSample(value: unknown, requests: number) {
  assert(isRecord(value), "Missing isolated completion result");
  assert.equal(value.workload, "isolated-completion");
  assert.equal(value.requests, requests);
  assert.equal(value.socketsAfterPoolClose, 0);
  assert.equal(value.cleanupFailures, 0);
  assert.equal(value.inputTokens, requests * 3);
  assert.equal(value.outputTokens, requests);
  const timings = (key: string) => {
    const rows = value[key];
    assert(Array.isArray(rows) && rows.length === requests);
    return rows.map(nonNegative);
  };
  const observationsMs = timings("observationsMs");
  const settledMs = timings("settledMs");
  assert(settledMs.every((duration, index) => duration >= observationsMs[index]!));
  const connections = nonNegative(value.connections);
  assert(Number.isInteger(connections) && connections >= 1 && connections <= requests);
  return {
    requests,
    connections,
    moduleImportMs: nonNegative(value.moduleImportMs),
    observationsMs,
    settledMs,
    dispatchMs: timings("dispatchMs"),
    cpuMs: nonNegative(value.cpuMs),
    peakRssBytes: nonNegative(value.peakRssBytes),
    memoryBefore: memory(value.memoryBefore),
    memoryAfter: memory(value.memoryAfter),
    memoryAfterDrain: memory(value.memoryAfterDrain),
    inputTokens: requests * 3,
    outputTokens: requests,
    cleanupFailures: 0,
    socketsAfterPoolClose: 0,
  };
}

export const isolatedCompletionWorkload = {
  name: "isolated-completion" as const,
  scope:
    "real OpenClaw isolated completion with a synthetic loopback model; process-cold, not disk-cold; no billed inference or end-to-end Gateway claims",
  initialization:
    "moduleImportMs measures the lazy application graph; first-call timings include ordinary runtime acquisition; CPU includes imports and all calls, not fixture setup or teardown",
  validate: parseIsolatedSample,
  summarize: (rows: ReturnType<typeof parseIsolatedSample>[]) => ({
    moduleImportMs: summarizeBenchmarkTimings(rows.map((row) => row.moduleImportMs)),
    firstObservationMs: summarizeBenchmarkTimings(rows.map((row) => row.observationsMs[0]!)),
    firstSettledMs: summarizeBenchmarkTimings(rows.map((row) => row.settledMs[0]!)),
    warmObservationSampleMedianMs: summarizeBenchmarkTimings(
      rows.map((row) => summarizeBenchmarkTimings(row.observationsMs.slice(1)).p50),
    ),
    warmSettledSampleMedianMs: summarizeBenchmarkTimings(
      rows.map((row) => summarizeBenchmarkTimings(row.settledMs.slice(1)).p50),
    ),
    cpuMs: summarizeBenchmarkTimings(rows.map((row) => row.cpuMs)),
    peakRssBytes: summarizeBenchmarkTimings(rows.map((row) => row.peakRssBytes)),
    connectionsPerSample: summarizeBenchmarkTimings(rows.map((row) => row.connections)),
  }),
};
