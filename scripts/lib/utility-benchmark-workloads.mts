import assert from "node:assert/strict";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { summarizeBenchmarkTimings } from "./benchmark-harness.mts";

export type UtilityBenchmarkWorkload = "decision-transport" | "progress-narration";

export function parseUtilityBenchmarkWorkload(value: string): UtilityBenchmarkWorkload {
  assert(
    value === "decision-transport" || value === "progress-narration",
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
} as const;

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
