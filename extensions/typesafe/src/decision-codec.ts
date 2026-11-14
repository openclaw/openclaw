import { randomUUID } from "node:crypto";
import {
  decodeSystemOneResponse,
  isDecisionBatchV1Representable,
  validateDecisionResultV2,
  validateDecisionBatchV2,
  type DecisionBatchResultV2,
  type DecisionEntry,
  type DecisionQuestionV2,
  type DecisionBatchV2,
} from "openclaw/plugin-sdk/decisions";
import type { Evaluation, EvaluationInput } from "./schema-definition.js";
import type { ImageAssets } from "./schema.js";

type TypeSafeDecisionBatch = DecisionBatchV2 & {
  readonly state:
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "json"; readonly value: Exclude<DecisionEntry, string> };
  readonly questions: Readonly<
    Record<string, Extract<DecisionQuestionV2, { type: "boolean" | "choice" | "score" }>>
  >;
};

export function decodeTypeSafeDecisionResult(
  batch: TypeSafeDecisionBatch,
  evaluation: Evaluation,
): DecisionBatchResultV2 | undefined {
  // Native metadata is not part of the decision accounting contract.
  const result = decodeSystemOneResponse(batch, {
    model: evaluation.model,
    answers: evaluation.answers,
    usage: {
      input_tokens: evaluation.usage.input_tokens,
      output_tokens: evaluation.usage.output_tokens,
    },
  });
  return validateDecisionResultV2(batch, result) ? result : undefined;
}

/** Preserve the admitted native subset; tagged image state adds referenced assets. */
export function translateTypeSafeDecisionBatch(
  batch: DecisionBatchV2,
): { batch: TypeSafeDecisionBatch; assets?: ImageAssets } | undefined {
  // Admit the full envelope before replacing image bytes with references.
  if (!validateDecisionBatchV2(batch)) {
    return undefined;
  }
  if (batch.state.type !== "image") {
    return isDecisionBatchV1Representable(batch) ? { batch } : undefined;
  }
  const match = /^data:image\/(png|jpeg);base64,/.exec(batch.state.dataUri);
  if (
    !match ||
    Object.values(batch.questions).some(
      (question) =>
        question.type !== "boolean" && question.type !== "choice" && question.type !== "score",
    )
  ) {
    return undefined;
  }
  // TypeSafe replaces references inside strings; a UUID must not occur in caller text.
  const callerText = JSON.stringify([batch.state.text, batch.questions]);
  let ref = randomUUID();
  while (callerText.includes(ref)) {
    ref = randomUUID();
  }
  const translated: DecisionBatchV2 = {
    state:
      batch.state.text === undefined
        ? { type: "text", text: ref }
        : { type: "json", value: [batch.state.text, ref] },
    questions: batch.questions,
  };
  if (!isDecisionBatchV1Representable(translated)) {
    return undefined;
  }
  return {
    batch: translated,
    assets: {
      [ref]: {
        type: "image",
        format: match[1] === "png" ? "png" : "jpg",
        data_base64: batch.state.dataUri.slice(match[0].length),
      },
    },
  };
}

export function encodeTypeSafeLocalInput(parsed: EvaluationInput): EvaluationInput {
  const questions: EvaluationInput["questions"] = {};
  for (const [id, question] of Object.entries(parsed.questions)) {
    const instructions = question.instructions ?? null;
    if (question.type === "score") {
      questions[id] = {
        ...question,
        instructions,
        // Send explicit text so the returned legend can be verified without reproducing Kev's renderer.
        criteria: question.criteria.map((level) =>
          typeof level === "string" ? level : level === null ? "" : JSON.stringify(level),
        ),
      };
    } else {
      questions[id] = { ...question, instructions };
    }
  }
  return { ...parsed, questions };
}

export function restoreTypeSafeLocalLegends(evaluation: Evaluation, parsed: EvaluationInput): void {
  for (const [id, question] of Object.entries(parsed.questions)) {
    const answer = evaluation.answers[id];
    if (question.type === "score" && answer?.type === "score") {
      answer.legend = Object.fromEntries(
        question.criteria.map((level, index) => [String(index), level]),
      );
    }
  }
}
