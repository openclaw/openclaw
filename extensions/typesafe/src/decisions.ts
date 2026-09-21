import type {
  DecisionBatch,
  DecisionBatchResult,
  DecisionProviderV1,
} from "openclaw/plugin-sdk/decisions";
import { evaluate as evaluateTypeSafe } from "./client.js";
import type { RuntimeConfig } from "./config.js";
import { decisionFailure } from "./errors.js";
import { MAX_CHOICE_OPTIONS, MAX_SCORE_LEVELS, parseInput } from "./schema.js";

/** Transport and result validation are shared with the independently usable agent tool. */
export function createDecisionProvider(getConfig: () => RuntimeConfig): DecisionProviderV1 {
  return {
    id: "typesafe",
    contractVersion: 1,
    isReady: () => {
      const config = getConfig();
      return Boolean(config.baseUrl || config.apiKey);
    },
    async evaluate(batch: DecisionBatch, context) {
      context.signal.throwIfAborted();
      const config = getConfig();
      if (!config.baseUrl && !config.apiKey) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const remaining = context.deadlineMonotonicMs - performance.now();
      if (remaining <= 0) {
        return { status: "unavailable", reason: "transport" };
      }
      if (
        Object.values(batch.questions).some((q) =>
          q.type === "choice"
            ? Object.keys(q.criteria).length > MAX_CHOICE_OPTIONS
            : q.type === "score" && q.criteria.length > MAX_SCORE_LEVELS,
        )
      ) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const questions = Object.fromEntries(
        Object.entries(batch.questions).map(([id, q]) => [
          id,
          q.type === "boolean" ? { ...q, type: "noul" } : q,
        ]),
      );
      // The vendor contract is narrower than host JSON (for example reserved keys).
      // Validate locally before credentials can be sent; never truncate/split a rubric.
      let input: ReturnType<typeof parseInput>;
      try {
        input = parseInput({ state: batch.state, questions, model: context.model });
      } catch {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      try {
        const { evaluation } = await evaluateTypeSafe(
          input,
          { ...config, timeoutMs: Math.min(config.timeoutMs, remaining) },
          context.signal,
        );
        context.signal.throwIfAborted();
        const answers: Record<string, DecisionBatchResult["answers"][string]> = {};
        for (const [id, answer] of Object.entries(evaluation.answers)) {
          if (answer.type === "noul") {
            answers[id] = { type: "boolean", probabilityTrue: answer.noul };
          } else if (answer.type === "choice") {
            answers[id] = answer;
          } else {
            const question = batch.questions[id];
            if (!question || question.type !== "score") {
              return { status: "unavailable", reason: "invalid-response" };
            }
            answers[id] = {
              type: "score",
              score: answer.score,
              confidence: answer.confidence,
              probabilities: question.criteria.map((_level, i) => answer.probabilities[String(i)]!),
            };
          }
        }
        return {
          status: "ok",
          result: {
            model: evaluation.model,
            answers,
            usage: {
              inputTokens: evaluation.usage.input_tokens,
              outputTokens: evaluation.usage.output_tokens,
            },
          },
        };
      } catch (error) {
        context.signal.throwIfAborted();
        return decisionFailure(error);
      }
    },
  };
}
