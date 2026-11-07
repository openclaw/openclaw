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

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string" },
      threshold: { type: "string" },
      beta: { type: "string", default: "1" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/decision-threshold.mts evaluate --data scores.json --threshold 0.5 [--beta 1]",
    );
    return;
  }
  assert(
    positionals.length === 1 && positionals[0] === "evaluate",
    "Expected evaluate command; use --help",
  );
  assert(
    values.data && values.threshold !== undefined && values.threshold.trim(),
    "Supply --data and explicit --threshold",
  );
  const threshold = unit(Number(values.threshold), "threshold");
  const beta = Number(values.beta);
  assert(
    Number.isFinite(beta) && beta > 0 && Number.isFinite(beta * beta) && beta * beta > 0,
    "beta must be finite and positive with representable square",
  );
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
