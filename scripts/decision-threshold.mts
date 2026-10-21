import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";

type Sample = { id: string; label: boolean; probabilityTrue: number | null };
type Dataset = {
  identity: { provider: string; model: string; rubricVersion: string; questionId: string };
  samples: Sample[];
};

function unit(value: unknown, name: string): number {
  assert(
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
    `${name} must be a finite number in [0, 1]`,
  );
  return value;
}

function readDataset(file: string): Dataset {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  assert(isRecord(value) && isRecord(value.identity), "Expected dataset identity and samples");
  const identity = value.identity;
  function identityText(key: string): string {
    const entry = identity[key];
    assert(typeof entry === "string" && entry.trim(), `Expected nonempty identity.${key}`);
    return entry;
  }
  assert(Array.isArray(value.samples) && value.samples.length > 0, "Expected nonempty samples");
  const ids = new Set<string>();
  const samples = value.samples.map((sample: unknown): Sample => {
    assert(isRecord(sample), "Expected sample object");
    assert(typeof sample.id === "string" && sample.id.trim(), "Expected nonempty sample id");
    assert(!ids.has(sample.id), "Duplicate sample id");
    ids.add(sample.id);
    assert(typeof sample.label === "boolean", "Expected Boolean human label");
    return {
      id: sample.id,
      label: sample.label,
      probabilityTrue:
        sample.probabilityTrue === null ? null : unit(sample.probabilityTrue, "probabilityTrue"),
    };
  });
  return {
    identity: {
      provider: identityText("provider"),
      model: identityText("model"),
      rubricVersion: identityText("rubricVersion"),
      questionId: identityText("questionId"),
    },
    samples,
  };
}

function metrics(samples: Sample[], threshold: number, beta: number) {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  let unscored = 0;
  for (const sample of samples) {
    if (sample.probabilityTrue === null) {
      unscored++;
    } else if (sample.probabilityTrue >= threshold) {
      if (sample.label) {
        truePositive++;
      } else {
        falsePositive++;
      }
    } else if (sample.label) {
      falseNegative++;
    } else {
      trueNegative++;
    }
  }
  const predictedPositive = truePositive + falsePositive;
  const actualPositive = truePositive + falseNegative;
  const betaSquared = beta * beta;
  const denominator =
    (1 + betaSquared) * truePositive + betaSquared * falseNegative + falsePositive;
  return {
    total: samples.length,
    scored: samples.length - unscored,
    unscored,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    precision: predictedPositive ? truePositive / predictedPositive : null,
    recall: actualPositive ? truePositive / actualPositive : null,
    fBeta: denominator ? ((1 + betaSquared) * truePositive) / denominator : null,
  };
}

type Metrics = ReturnType<typeof metrics>;

function meetsTargets(result: Metrics, minPrecision: number, minRecall: number): boolean {
  return (
    result.precision !== null &&
    result.recall !== null &&
    result.precision >= minPrecision &&
    result.recall >= minRecall
  );
}

function tune(
  tuning: Dataset,
  heldOut: Dataset,
  beta: number,
  minPrecision: number,
  minRecall: number,
) {
  assert(
    JSON.stringify(tuning.identity) === JSON.stringify(heldOut.identity),
    "Tuning and held-out identities must match",
  );
  const ids = new Set(tuning.samples.map((sample) => sample.id));
  assert(
    heldOut.samples.every((sample) => !ids.has(sample.id)),
    "Tuning and held-out sample IDs overlap",
  );
  // Only tuning scores generate candidates. Equal scores move together under >=.
  // Endpoints plus observed scores cover every useful policy with defined precision.
  const thresholds = [
    ...new Set([
      0,
      1,
      ...tuning.samples.flatMap((sample) =>
        sample.probabilityTrue === null ? [] : [sample.probabilityTrue],
      ),
    ]),
  ].toSorted((a, b) => b - a);
  let selected: { threshold: number; metrics: Metrics } | null = null;
  for (const threshold of thresholds) {
    const result = metrics(tuning.samples, threshold, beta);
    if (
      meetsTargets(result, minPrecision, minRecall) &&
      result.fBeta !== null &&
      (selected === null || result.fBeta > selected.metrics.fBeta!)
    ) {
      selected = { threshold, metrics: result };
    }
  }
  const evaluation = selected === null ? null : metrics(heldOut.samples, selected.threshold, beta);
  const meetsHeldOutTargets =
    evaluation === null ? null : meetsTargets(evaluation, minPrecision, minRecall);
  return {
    status:
      selected === null
        ? "no-feasible-threshold"
        : meetsHeldOutTargets
          ? "held-out-targets-met"
          : "held-out-targets-missed",
    identity: tuning.identity,
    policy: {
      comparison: "probabilityTrue >= threshold",
      beta,
      minPrecision,
      minRecall,
      tieBreak: "highest-threshold",
    },
    selected,
    heldOut: evaluation,
    meetsHeldOutTargets,
    baseline: {
      threshold: 0.5,
      tuning: metrics(tuning.samples, 0.5, beta),
      heldOut: metrics(heldOut.samples, 0.5, beta),
    },
  };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string" },
      tuning: { type: "string" },
      "held-out": { type: "string" },
      "min-precision": { type: "string" },
      "min-recall": { type: "string" },
      threshold: { type: "string" },
      beta: { type: "string", default: "1" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/decision-threshold.mts evaluate --data scores.json --threshold 0.5 [--beta 1]\n" +
        "node scripts/decision-threshold.mts tune --tuning tuning.json --held-out held-out.json --min-precision 0.8 --min-recall 0.8 [--beta 1]",
    );
    return;
  }
  assert(
    positionals.length === 1 && (positionals[0] === "evaluate" || positionals[0] === "tune"),
    "Expected evaluate or tune command; use --help",
  );
  const beta = Number(values.beta);
  assert(
    Number.isFinite(beta) && beta > 0 && Number.isFinite(beta * beta) && beta * beta > 0,
    "beta must be finite and positive with representable square",
  );
  if (positionals[0] === "tune") {
    assert(
      values.data === undefined && values.threshold === undefined,
      "tune does not accept --data or --threshold",
    );
    assert(values.tuning && values["held-out"], "Supply separate --tuning and --held-out files");
    assert(
      values["min-precision"]?.trim() && values["min-recall"]?.trim(),
      "Supply explicit --min-precision and --min-recall",
    );
    const report = tune(
      readDataset(values.tuning),
      readDataset(values["held-out"]),
      beta,
      unit(Number(values["min-precision"]), "min-precision"),
      unit(Number(values["min-recall"]), "min-recall"),
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "held-out-targets-met") {
      process.exitCode = 2;
    }
    return;
  }
  assert(
    values.tuning === undefined &&
      values["held-out"] === undefined &&
      values["min-precision"] === undefined &&
      values["min-recall"] === undefined,
    "evaluate does not accept tuning options",
  );
  assert(values.data && values.threshold?.trim(), "Supply --data and explicit --threshold");
  const threshold = unit(Number(values.threshold), "threshold");
  const dataset = readDataset(values.data);
  console.log(
    JSON.stringify(
      {
        identity: dataset.identity,
        policy: { threshold, comparison: "probabilityTrue >= threshold", beta },
        evaluation: metrics(dataset.samples, threshold, beta),
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  // Do not echo input rows, file contents, or parser errors containing evidence.
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : "Could not read decision dataset or arguments; use --help",
  );
  process.exitCode = 1;
}
