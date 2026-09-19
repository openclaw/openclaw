import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { JudgmentOutcome } from "../src/judgments/types.js";
import { estimateMessagesTokens } from "../src/agents/compaction-planning.js";
import { curateCompactionSummarizerInput } from "../src/agents/agent-hooks/compaction-input-curation.js";
import {
  COMPACTION_CURATION_CALIBRATION_CASES,
  type CompactionCurationCalibrationCase,
} from "./fixtures/compaction-curation-corpus.js";

type NumericSummary = {
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
};

type Sample = {
  wallMs: number;
  judgmentMs: number;
  heapDeltaBytes: number;
  rssBytes: number;
};

function summarize(values: number[]): NumericSummary {
  const ordered = values.toSorted((a, b) => a - b);
  const percentile = (percent: number) =>
    ordered[Math.max(0, Math.ceil((percent / 100) * ordered.length) - 1)] ?? 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    avg: Number(avg.toFixed(3)),
    p50: Number(percentile(50).toFixed(3)),
    p95: Number(percentile(95).toFixed(3)),
    min: Number((ordered[0] ?? 0).toFixed(3)),
    max: Number((ordered.at(-1) ?? 0).toFixed(3)),
  };
}

function parseInteger(raw: string | undefined, fallback: number, label: string, min: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be an integer >= ${min}`);
  }
  return value;
}

function buildFixtureOutcome(
  calibrationCase: CompactionCurationCalibrationCase,
  questionIds: string[],
): JudgmentOutcome {
  if (!calibrationCase.expectedChoice || calibrationCase.expectedProbability === undefined) {
    throw new Error(`Calibration case ${calibrationCase.id} unexpectedly reached judgment evaluation`);
  }
  const choice = calibrationCase.expectedChoice;
  const probability = calibrationCase.expectedProbability;
  const alternatives = ["essential", "relevant", "redundant", "transient", "uncertain"];
  const remainder = Math.max(0, 1 - probability);
  const otherProbability = remainder / (alternatives.length - 1);
  return {
    status: "ok",
    result: {
      model: "fixture-calibration",
      answers: Object.fromEntries(
        questionIds.map((id) => [
          id,
          {
            type: "choice",
            choice,
            probabilities: Object.fromEntries(
              alternatives.map((candidate) => [
                candidate,
                candidate === choice ? probability : otherProbability,
              ]),
            ),
          },
        ]),
      ),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    },
    provenance: {
      providerId: "fixture-calibration",
      rubricVersion: "1",
      runtimeGeneration: "fixture",
    },
  };
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function runCase(
  calibrationCase: CompactionCurationCalibrationCase,
  samples: number,
  judgmentDelayMs: number,
) {
  const originalTokens = estimateMessagesTokens(calibrationCase.messages);
  const originalChars = JSON.stringify(calibrationCase.messages).length;
  const measurements: Sample[] = [];
  let lastResult: Awaited<ReturnType<typeof curateCompactionSummarizerInput>> | undefined;

  for (let index = 0; index < samples; index += 1) {
    let judgmentMs = 0;
    const before = process.memoryUsage();
    const started = performance.now();
    const result = await curateCompactionSummarizerInput(
      {
        messages: calibrationCase.messages,
        unresolvedAsk: calibrationCase.unresolvedAsk,
        signal: new AbortController().signal,
      },
      async (batch, options) => {
        options.signal.throwIfAborted();
        const judgmentStarted = performance.now();
        await delay(judgmentDelayMs);
        options.signal.throwIfAborted();
        const outcome = buildFixtureOutcome(calibrationCase, Object.keys(batch.questions));
        judgmentMs += performance.now() - judgmentStarted;
        return outcome;
      },
    );
    const wallMs = performance.now() - started;
    const after = process.memoryUsage();
    measurements.push({
      wallMs,
      judgmentMs,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      rssBytes: after.rss,
    });
    lastResult = result;
  }

  if (!lastResult) {
    throw new Error(`No benchmark result for ${calibrationCase.id}`);
  }

  const curatedTokens = estimateMessagesTokens(lastResult.messages);
  const curatedChars = JSON.stringify(lastResult.messages).length;
  const tokenSavings = originalTokens - curatedTokens;
  const charSavings = originalChars - curatedChars;
  const passed =
    lastResult.considered === calibrationCase.expectedConsidered &&
    lastResult.omitted === calibrationCase.expectedOmitted &&
    (!calibrationCase.retainedMarker ||
      JSON.stringify(lastResult.messages).includes(calibrationCase.retainedMarker));

  return {
    id: calibrationCase.id,
    description: calibrationCase.description,
    passed,
    expected: {
      considered: calibrationCase.expectedConsidered,
      omitted: calibrationCase.expectedOmitted,
      retainedMarker: calibrationCase.retainedMarker ?? null,
    },
    actual: {
      status: lastResult.status,
      considered: lastResult.considered,
      omitted: lastResult.omitted,
    },
    input: {
      originalTokens,
      curatedTokens,
      tokenSavings,
      tokenSavingsPct:
        originalTokens > 0 ? Number(((tokenSavings / originalTokens) * 100).toFixed(2)) : 0,
      originalChars,
      curatedChars,
      charSavings,
      charSavingsPct:
        originalChars > 0 ? Number(((charSavings / originalChars) * 100).toFixed(2)) : 0,
    },
    timing: {
      wallMs: summarize(measurements.map((sample) => sample.wallMs)),
      judgmentMs: summarize(measurements.map((sample) => sample.judgmentMs)),
    },
    memory: {
      heapDeltaBytes: summarize(measurements.map((sample) => sample.heapDeltaBytes)),
      rssBytes: summarize(measurements.map((sample) => sample.rssBytes)),
    },
  };
}

export async function runCompactionCurationCalibration(params: {
  samples: number;
  judgmentDelayMs: number;
  caseIds?: readonly string[];
}) {
  const selected = params.caseIds?.length
    ? COMPACTION_CURATION_CALIBRATION_CASES.filter((entry) => params.caseIds?.includes(entry.id))
    : [...COMPACTION_CURATION_CALIBRATION_CASES];
  if (selected.length === 0) {
    throw new Error("No matching calibration cases");
  }

  const cases = [];
  for (const calibrationCase of selected) {
    cases.push(await runCase(calibrationCase, params.samples, params.judgmentDelayMs));
  }

  const totalOriginalTokens = cases.reduce((sum, entry) => sum + entry.input.originalTokens, 0);
  const totalCuratedTokens = cases.reduce((sum, entry) => sum + entry.input.curatedTokens, 0);
  return {
    schemaVersion: 1,
    measurementScope:
      "curation-helper fixture calibration; does not claim real provider or summarizer latency",
    node: process.version,
    samplesPerCase: params.samples,
    simulatedJudgmentDelayMs: params.judgmentDelayMs,
    corpusCases: cases.length,
    passedCases: cases.filter((entry) => entry.passed).length,
    aggregate: {
      originalTokens: totalOriginalTokens,
      curatedTokens: totalCuratedTokens,
      tokenSavings: totalOriginalTokens - totalCuratedTokens,
      tokenSavingsPct:
        totalOriginalTokens > 0
          ? Number(
              (((totalOriginalTokens - totalCuratedTokens) / totalOriginalTokens) * 100).toFixed(2),
            )
          : 0,
    },
    cases,
  };
}

function printReport(report: Awaited<ReturnType<typeof runCompactionCurationCalibration>>): void {
  console.log(
    `Compaction curation calibration: ${report.passedCases}/${report.corpusCases} cases matched expected policy`,
  );
  console.log(
    `Estimated summarizer input tokens: ${report.aggregate.originalTokens} -> ${report.aggregate.curatedTokens} (${report.aggregate.tokenSavingsPct}% reduction across corpus)`,
  );
  console.log("Note: token counts use OpenClaw's compaction planning estimator; timings use fixture judgments.");
  console.log("");
  for (const entry of report.cases) {
    console.log(
      [
        entry.passed ? "PASS" : "FAIL",
        entry.id,
        `considered=${entry.actual.considered}`,
        `omitted=${entry.actual.omitted}`,
        `tokens=${entry.input.originalTokens}->${entry.input.curatedTokens}`,
        `wall-p50=${entry.timing.wallMs.p50}ms`,
        `rss-p50=${Math.round(entry.memory.rssBytes.p50 / 1024 / 1024)}MiB`,
      ].join(" "),
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      samples: { type: "string", default: "20" },
      "judgment-delay-ms": { type: "string", default: "0" },
      case: { type: "string", multiple: true },
      output: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(`Usage:
  pnpm test:compaction:curation:bench [options]

Options:
  --samples <n>             Measured samples per corpus case (default: 20)
  --judgment-delay-ms <n>   Simulated judgment latency per request (default: 0)
  --case <id>               Run only a specific corpus case; repeatable
  --output <path>           Write the JSON report to disk
  --json                    Print the full JSON report
  --help                    Show this help

This harness measures the production curation helper with deterministic fixture judgments.
It uses OpenClaw's compaction token estimator. It does not represent real provider or
summarizer latency; use it to make calibration and before/after runs repeatable.`);
    return;
  }

  const report = await runCompactionCurationCalibration({
    samples: parseInteger(values.samples, 20, "--samples", 1),
    judgmentDelayMs: parseInteger(values["judgment-delay-ms"], 0, "--judgment-delay-ms", 0),
    caseIds: values.case,
  });

  if (values.output) {
    fs.mkdirSync(path.dirname(values.output), { recursive: true });
    fs.writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  if (report.passedCases !== report.corpusCases) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
