import { isDeepStrictEqual } from "node:util";
import { EvaluationError } from "./errors.js";
import type { Evaluation, EvaluationInput } from "./schema-definition.js";
import {
  isEvaluation,
  isEvaluationInput,
  isEvaluationQuestion,
} from "./schema-validator.generated.js";

export type { Evaluation, EvaluationInput } from "./schema-definition.js";

// Transport/CPU guards; each server enforces its model's context budget.
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_JSON_NODES = 262144;
const MAX_JSON_DEPTH = 64;

/** Reject non-JSON values and excessive structure before schema validation or serialization. */
function assertBoundedJson(value: unknown): void {
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new EvaluationError(
        "TypeSafe JSON exceeds resource limits (262144 nodes or depth 64).",
        "unsupported-input",
      );
    }
    if (node === null || typeof node === "string" || typeof node === "boolean") {
      return;
    }
    if (typeof node === "number" && Number.isFinite(node)) {
      return;
    }
    if (typeof node !== "object" || !node) {
      throw new EvaluationError("TypeSafe input must be JSON.", "unsupported-input");
    }
    const array = Array.isArray(node);
    const prototype = Object.getPrototypeOf(node);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    ) {
      throw new EvaluationError("TypeSafe input must be plain JSON.", "unsupported-input");
    }
    if (array) {
      if (
        node.length > MAX_JSON_NODES ||
        Object.keys(node).length !== node.length ||
        Object.hasOwn(node, "toJSON")
      ) {
        throw new EvaluationError(
          "TypeSafe input must be a bounded JSON array.",
          "unsupported-input",
        );
      }
      for (let index = 0; index < node.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(node, index);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new EvaluationError("TypeSafe input must be plain JSON.", "unsupported-input");
        }
        visit(descriptor.value, depth + 1);
      }
      return;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new EvaluationError("TypeSafe input contains a reserved key.", "unsupported-input");
      }
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new EvaluationError("TypeSafe input must be plain JSON.", "unsupported-input");
      }
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_JSON_BYTES) {
    throw new EvaluationError(
      "TypeSafe JSON exceeds the plugin resource limit of 4 MiB.",
      "unsupported-input",
    );
  }
}

/** Validate without including supplied state in diagnostics. */
export function parseInput(value: unknown): EvaluationInput {
  assertBoundedJson(value);
  if (!isEvaluationInput(value)) {
    // Report fixed schema guidance and ordinal positions, never supplied values/keys.
    if (
      value &&
      typeof value === "object" &&
      "questions" in value &&
      value.questions &&
      typeof value.questions === "object" &&
      !Array.isArray(value.questions)
    ) {
      for (const [index, q] of Object.values(value.questions).entries()) {
        if (!isEvaluationQuestion(q)) {
          const kind = q && typeof q === "object" && "type" in q ? q.type : undefined;
          const hint =
            kind === "choice"
              ? "Choice requires 2–255 criteria descriptions."
              : kind === "score"
                ? "Score requires 2–10 ordered criteria descriptions."
                : kind === "noul"
                  ? "Noul criteria may contain only true/false descriptions, or null."
                  : "type must be choice, score, or noul.";
          throw new EvaluationError(
            `Invalid TypeSafe questions entry #${index + 1}: ${hint} Instructions/descriptions accept text, object, array, or null; no extra question fields.`,
            "unsupported-input",
          );
        }
      }
    }
    throw new EvaluationError(
      "Invalid TypeSafe evaluation input: supply state (text/object/array/null), a nonempty questions map, and optionally a valid model ID; no extra fields.",
      "unsupported-input",
    );
  }
  return value;
}

/** Check the response schema and correspondence to this exact question batch. */
export function parseResult(value: unknown, input: EvaluationInput): Evaluation {
  try {
    assertBoundedJson(value);
    if (!isEvaluation(value)) {
      throw new Error();
    }
    const questions = Object.entries(input.questions);
    if (Object.keys(value.answers).length !== questions.length) {
      throw new Error();
    }
    for (const [id, expected] of questions) {
      const answer = value.answers[id];
      if (!answer || answer.type !== expected.type) {
        throw new Error();
      }
      if (answer.type === "noul") {
        continue;
      }
      const labels =
        expected.type === "score"
          ? expected.criteria.map((_, index) => String(index))
          : expected.type === "choice"
            ? Object.keys(expected.criteria)
            : [];
      if (
        Object.keys(answer.probabilities).length !== labels.length ||
        labels.some((label) => !Object.hasOwn(answer.probabilities, label))
      ) {
        throw new Error();
      }
      const total = Object.values(answer.probabilities).reduce((sum, item) => sum + item, 0);
      if (!(total > 0)) {
        throw new Error();
      }
      if (answer.type === "choice" && !labels.includes(answer.choice)) {
        throw new Error();
      }
      if (answer.type === "score" && expected.type === "score") {
        // Score and probabilities are reported independently; do not recompute rounded estimates.
        if (
          answer.score > labels.length - 1 ||
          Object.keys(answer.legend).length !== labels.length ||
          labels.some(
            (label, index) => !isDeepStrictEqual(answer.legend[label], expected.criteria[index]),
          )
        ) {
          throw new Error();
        }
      }
    }
    return value;
  } catch {
    throw new Error("TypeSafe returned an invalid evaluation response.");
  }
}
