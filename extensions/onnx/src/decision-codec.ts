import type {
  DecisionAnswer,
  DecisionBatchResult,
  DecisionEntry,
  DecisionQuestion,
} from "openclaw/plugin-sdk/decisions";
import {
  UnsupportedInputError,
  type ClassificationInput,
  type ClassificationResult,
} from "./models/types.js";

function render(value: DecisionEntry): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function rubric(question: DecisionQuestion) {
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria);
    const descriptions = Object.fromEntries(
      labels.map((label) => {
        const value = question.criteria[label];
        return [label, value === null || value === undefined ? label : render(value)];
      }),
    );
    return { labels, descriptions };
  }
  if (question.type === "score") {
    const labels = question.criteria.map((_, index) => String(index));
    return {
      labels,
      descriptions: Object.fromEntries(
        question.criteria.flatMap((value, index) =>
          value === null ? [] : [[String(index), render(value)]],
        ),
      ),
    };
  }
  // Bare Boolean labels do not describe the predicate to a zero-shot classifier.
  if (question.criteria?.true == null || question.criteria.false == null) {
    throw new UnsupportedInputError(
      "ONNX Boolean questions require true and false criterion descriptions.",
    );
  }
  return {
    labels: ["true", "false"],
    descriptions: { true: render(question.criteria.true), false: render(question.criteria.false) },
  };
}

function probabilities(logits: readonly number[]): number[] {
  const max = Math.max(...logits);
  const weights = logits.map((value) => Math.exp(value - max));
  const sum = weights.reduce((total, value) => total + value, 0);
  return weights.map((value) => value / sum);
}

export function encodeOnnxDecisionInputs(
  state: DecisionEntry,
  questions: Readonly<Record<string, DecisionQuestion>>,
) {
  const entries = Object.entries(questions);
  const text = render(state);
  const inputs = entries.map(([, question]): ClassificationInput => {
    const selected = rubric(question);
    return {
      text,
      task: "decision",
      ...selected,
      ...(question.instructions == null ? {} : { instructions: render(question.instructions) }),
    };
  });
  return { entries, inputs };
}

export function decodeOnnxDecisionResults(
  model: string,
  { entries, inputs }: ReturnType<typeof encodeOnnxDecisionInputs>,
  results: readonly ClassificationResult[],
): DecisionBatchResult {
  const answers = new Map<string, DecisionAnswer>();
  let inputTokens = 0;
  entries.forEach(([id, question], index) => {
    const result = results[index]!;
    const labels = inputs[index]!.labels;
    const values = probabilities(result.logits);
    inputTokens += result.inputTokens;
    if (question.type === "boolean") {
      answers.set(id, { type: "boolean", probabilityTrue: values[0]! });
    } else if (question.type === "score") {
      const score = Math.min(
        values.length - 1,
        values.reduce((sum, value, position) => sum + value * position, 0),
      );
      answers.set(id, { type: "score", score, probabilities: values });
    } else {
      const best = values.indexOf(Math.max(...values));
      answers.set(id, {
        type: "choice",
        choice: labels[best]!,
        probabilities: Object.fromEntries(
          labels.map((label, position) => [label, values[position]!]),
        ),
      });
    }
  });
  return {
    model,
    answers: Object.fromEntries(answers),
    usage: { inputTokens },
  };
}
