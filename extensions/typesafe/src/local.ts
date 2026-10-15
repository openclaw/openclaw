import { parseResult, type Evaluation, type EvaluationInput } from "./schema.js";

export function localInput(input: EvaluationInput): EvaluationInput {
  const questions: EvaluationInput["questions"] = {};
  for (const [id, question] of Object.entries(input.questions)) {
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
  return { ...input, questions };
}

/**
 * Local Kev/llama-swap servers report their own telemetry alongside the decision
 * (top-level metrics/scoring, extra usage keys). The hosted path stays strict, but a
 * local response only has to satisfy the contract fields (#173039).
 */
function contractFields(value: object): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  const usageFields =
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? (() => {
          const usageRecord = usage as Record<string, unknown>;
          return {
            input_tokens: usageRecord.input_tokens,
            output_tokens: usageRecord.output_tokens,
          };
        })()
      : usage;
  return { model: record.model, answers: record.answers, usage: usageFields };
}

export function parseLocalResult(
  value: unknown,
  wireInput: EvaluationInput,
  originalInput: EvaluationInput,
): Evaluation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid local System One response.");
  }
  let result = value;
  if ("latency_ms" in value) {
    const { latency_ms, ...payload } = value;
    if (typeof latency_ms !== "number" || !Number.isFinite(latency_ms) || latency_ms < 0) {
      throw new Error("Invalid local System One latency metadata.");
    }
    result = payload;
  }
  const evaluation = parseResult(contractFields(result), wireInput);
  for (const [id, question] of Object.entries(originalInput.questions)) {
    const answer = evaluation.answers[id];
    if (question.type === "score" && answer?.type === "score") {
      answer.legend = Object.fromEntries(
        question.criteria.map((level, index) => [String(index), level]),
      );
    }
  }
  return evaluation;
}
