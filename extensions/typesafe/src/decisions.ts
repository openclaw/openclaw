import type {
  DecisionBatch,
  DecisionBatchResult,
  DecisionProviderV1,
} from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { RuntimeConfig } from "./config.js";
import { decisionFailure } from "./errors.js";

const loadClient = createLazyRuntimeModule(() => import("./client.js"));

/** Translate the host-selected decision contract through the TypeSafe transport. */
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
      // Registration and readiness do not need the transport or compiled validators.
      // Sample configuration and the remaining deadline after the cold import settles.
      const { evaluate: evaluateTypeSafe } = await loadClient();
      context.signal.throwIfAborted();
      const config = getConfig();
      if (!config.baseUrl && !config.apiKey) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const remaining = context.deadlineMonotonicMs - performance.now();
      if (remaining <= 0) {
        return { status: "unavailable", reason: "transport" };
      }
      const questions = Object.fromEntries(
        Object.entries(batch.questions).map(([id, q]) => [
          id,
          q.type === "boolean" ? { ...q, type: "noul" } : q,
        ]),
      );
      try {
        const { evaluation } = await evaluateTypeSafe(
          { state: batch.state, questions, model: context.model },
          { ...config, timeoutMs: Math.min(config.timeoutMs, remaining) },
          context.signal,
          context.deadlineMonotonicMs,
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
