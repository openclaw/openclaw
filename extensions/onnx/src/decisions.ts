import type {
  DecisionAnswer,
  DecisionBatch,
  DecisionEntry,
  DecisionProviderV1,
  DecisionQuestion,
} from "openclaw/plugin-sdk/decisions";
import { findModel } from "./catalog.js";
import type { ClassificationInput, ClassificationResult } from "./models/types.js";
import { UnsupportedInputError } from "./models/types.js";
import { OnnxWorkerError } from "./protocol.js";

type Classifier = {
  classify(
    model: string,
    inputs: ClassificationInput[],
    signal: AbortSignal,
  ): Promise<ClassificationResult[]>;
};

function render(value: DecisionEntry): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function rubric(question: DecisionQuestion): {
  labels: string[];
  descriptions?: Record<string, string>;
} {
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
  if (logits.length < 2 || logits.some((value) => !Number.isFinite(value))) {
    throw new Error("ONNX returned invalid label logits.");
  }
  const max = Math.max(...logits);
  const weights = logits.map((value) => Math.exp(value - max));
  const sum = weights.reduce((total, value) => total + value, 0);
  return weights.map((value) => value / sum);
}

export function createOnnxProvider(
  client: Classifier,
  warn: (message: string) => void,
): DecisionProviderV1 {
  return {
    id: "onnx",
    contractVersion: 1,
    async evaluate(batch: DecisionBatch, context) {
      context.signal.throwIfAborted();
      if (!findModel(context.model)) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      try {
        const entries = Object.entries(batch.questions);
        if (entries.length === 0 || entries.length > 32) {
          throw new UnsupportedInputError("Unsupported batch size.");
        }
        const text = render(batch.state);
        const inputs = entries.map(([, question]): ClassificationInput => {
          const selected = rubric(question);
          if (selected.labels.length < 2 || selected.labels.length > 64) {
            throw new UnsupportedInputError("Unsupported label count.");
          }
          return {
            text,
            task: "decision",
            ...selected,
            ...(question.instructions == null
              ? {}
              : { instructions: render(question.instructions) }),
          };
        });
        const results = await client.classify(context.model, inputs, context.signal);
        context.signal.throwIfAborted();
        if (results.length !== entries.length) {
          throw new Error("ONNX returned an incomplete batch.");
        }
        const answers = new Map<string, DecisionAnswer>();
        let inputTokens = 0;
        entries.forEach(([id, question], index) => {
          const result = results[index]!;
          const labels = inputs[index]!.labels;
          if (result.logits.length !== labels.length) {
            throw new Error("ONNX returned an incomplete distribution.");
          }
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
          status: "ok",
          result: {
            model: context.model,
            answers: Object.fromEntries(answers),
            usage: { inputTokens },
          },
        };
      } catch (error) {
        context.signal.throwIfAborted();
        if (
          error instanceof UnsupportedInputError ||
          (error instanceof OnnxWorkerError && error.code === "unsupported-input")
        ) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        if (error instanceof OnnxWorkerError) {
          if (error.code === "model-missing" || error.code === "model-integrity") {
            warn(
              `ONNX model ${context.model} is missing or invalid. Run openclaw onnx verify ${context.model}; use download or prepare a local export as listed by openclaw onnx models.`,
            );
          } else if (error.code === "dependency-unavailable") {
            warn(
              "ONNX Runtime is unavailable. Install the optional ONNX plugin dependencies for this platform.",
            );
          }
          return { status: "unavailable", reason: "transport" };
        }
        return { status: "unavailable", reason: "invalid-response" };
      }
    },
  };
}
