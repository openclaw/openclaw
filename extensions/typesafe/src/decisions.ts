import type {
  DecisionBatchV2,
  DecisionBatchResultV2,
  DecisionProviderV2,
} from "openclaw/plugin-sdk/decisions";
import { evaluate as evaluateTypeSafe } from "./client.js";
import { runtimeSettings, type RuntimeConfig } from "./config.js";
import { decisionFailure } from "./errors.js";

const LOCAL_AUTH_MARKER = "typesafe-local";

/** Translate the host-selected decision contract through the TypeSafe transport. */
export function createDecisionProvider(getConfig: () => RuntimeConfig): DecisionProviderV2 {
  return {
    id: "typesafe",
    contractVersion: 2,
    provider: {
      label: "TypeSafe AI",
      auth: [],
      authScope: "plugin",
      resolveSyntheticAuth: () => {
        const config = getConfig();
        if (config.baseUrl) {
          return { apiKey: LOCAL_AUTH_MARKER, mode: "api-key", source: "typesafe-local" };
        }
        return config.apiKey
          ? { apiKey: config.apiKey, mode: "api-key", source: "typesafe-prepared-secret" }
          : undefined;
      },
    },
    async evaluate(batch: DecisionBatchV2, context) {
      context.signal.throwIfAborted();
      if (
        (batch.state.type !== "text" && batch.state.type !== "json") ||
        Object.values(batch.questions).some((q) => q.type === "sort" || q.type === "tags") ||
        (context.reasoning !== undefined && context.reasoning !== "auto")
      ) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const settings = runtimeSettings(context.config.plugins?.entries?.typesafe?.config);
      const config = {
        ...settings,
        apiKey: settings.baseUrl ? undefined : context.auth.apiKey,
      };
      if (!config.baseUrl && (!config.apiKey || config.apiKey === LOCAL_AUTH_MARKER)) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const remaining = context.deadlineMonotonicMs - performance.now();
      if (remaining <= 0) {
        return { status: "unavailable", reason: "transport" };
      }
      const state = batch.state.type === "text" ? batch.state.text : batch.state.value;
      const questions = Object.fromEntries(
        Object.entries(batch.questions).map(([id, q]) => [
          id,
          q.type === "boolean" ? { ...q, type: "noul" } : q,
        ]),
      );
      try {
        const { evaluation } = await evaluateTypeSafe(
          {
            // System One accepts text/object/array/null; encode explicit JSON scalars as text.
            state:
              typeof state === "number" || typeof state === "boolean"
                ? JSON.stringify(state)
                : state,
            questions,
            model: context.model.id,
          },
          { ...config, timeoutMs: Math.min(config.timeoutMs, remaining) },
          context.signal,
          context.deadlineMonotonicMs,
        );
        context.signal.throwIfAborted();
        const answers: Record<string, DecisionBatchResultV2["answers"][string]> = {};
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
