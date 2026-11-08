import { isDeepStrictEqual } from "node:util";
import type { DecisionBatch, DecisionBatchResult } from "openclaw/plugin-sdk/decisions";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "../openclaw.plugin.json" with { type: "json" };

const MODEL = manifest.decisionModels[0]!.id;
const LIMITS = manifest.decisionModels[0]!.capabilities;

export function supportsSubQDecisionBatch(batch: DecisionBatch, model: string): boolean {
  const questions = Object.entries(batch.questions);
  return (
    model === MODEL &&
    batch.state !== null &&
    questions.length > 0 &&
    questions.length <= LIMITS.maxQuestions &&
    questions.every(([id, question]) => {
      if (id.length > 100) {
        return false;
      }
      if (question.type === "choice") {
        const count = Object.keys(question.criteria).length;
        return count >= 2 && count <= LIMITS.maxChoiceAlternatives;
      }
      if (question.type === "score") {
        return question.criteria.length >= 2 && question.criteria.length <= LIMITS.maxScoreLevels;
      }
      return true;
    })
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Invalid SubQ response.");
  }
  return value;
}

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Invalid SubQ probability.");
  }
  return value;
}

/** Translate the documented wire contract; the host also validates the resulting Decision batch. */
export function decodeSubQDecisionResult(
  payload: unknown,
  batch: DecisionBatch,
): DecisionBatchResult {
  const result = record(payload);
  const wireAnswers = record(result.answers);
  if (
    result.model !== MODEL ||
    Object.keys(wireAnswers).length !== Object.keys(batch.questions).length
  ) {
    throw new Error("Invalid SubQ result.");
  }
  const answers: Record<string, DecisionBatchResult["answers"][string]> = Object.create(null);
  for (const [id, question] of Object.entries(batch.questions)) {
    const answer = record(wireAnswers[id]);
    if (question.type === "boolean") {
      if (answer.type !== "noul") {
        throw new Error("Invalid SubQ answer type.");
      }
      answers[id] = { type: "boolean", probabilityTrue: probability(answer.noul) };
      continue;
    }
    if (answer.type !== question.type) {
      throw new Error("Invalid SubQ answer type.");
    }
    const labels =
      question.type === "score"
        ? question.criteria.map((_, i) => String(i))
        : Object.keys(question.criteria);
    const distribution = record(answer.probabilities);
    if (
      Object.keys(distribution).length !== labels.length ||
      labels.some((key) => !Object.hasOwn(distribution, key))
    ) {
      throw new Error("Invalid SubQ distribution.");
    }
    const probabilities = labels.map((key) => probability(distribution[key]));
    if (!probabilities.some((p) => p > 0)) {
      throw new Error("Invalid SubQ distribution.");
    }
    const confidence = answer.confidence === undefined ? undefined : probability(answer.confidence);
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !labels.includes(answer.choice)) {
        throw new Error("Invalid SubQ choice.");
      }
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: Object.fromEntries(labels.map((key, i) => [key, probabilities[i]!])),
        ...(confidence === undefined ? {} : { confidence }),
      };
    } else {
      const legend = record(answer.legend);
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > labels.length - 1 ||
        Object.keys(legend).length !== labels.length ||
        labels.some((key, i) => !isDeepStrictEqual(legend[key], question.criteria[i]))
      ) {
        throw new Error("Invalid SubQ score.");
      }
      answers[id] = {
        type: "score",
        score: answer.score,
        probabilities,
        ...(confidence === undefined ? {} : { confidence }),
      };
    }
  }
  const usage = record(result.usage);
  const inputTokens = usage.input_tokens;
  if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    throw new Error("Invalid SubQ usage.");
  }
  if (usage.output_tokens !== 0) {
    throw new Error("Invalid SubQ output usage.");
  }
  return { model: MODEL, answers, usage: { inputTokens, outputTokens: 0 } };
}

export function encodeSubQDecisionRequest(batch: DecisionBatch, modelId: string): string {
  return JSON.stringify({
    model: modelId,
    state: batch.state,
    questions: Object.fromEntries(
      Object.entries(batch.questions).map(([id, question]) => [
        id,
        question.type === "boolean" ? { ...question, type: "noul" } : question,
      ]),
    ),
  });
}
