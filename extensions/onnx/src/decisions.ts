import {
  isDecisionBatchV1Representable,
  validateDecisionResultV2,
} from "openclaw/plugin-sdk/decisions";
import type { DecisionProviderV1, DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { executeOnnxDecision } from "./decision-execution.js";
import type { InferenceWorkerClient } from "./worker-client.js";

/** The standalone CLI still consumes the V1 data contract. */
export function createOnnxProvider(
  client: Pick<InferenceWorkerClient, "classify">,
  warn: (message: string) => void,
): DecisionProviderV1 {
  return {
    id: "onnx",
    contractVersion: 1,
    evaluate(batch, context) {
      return executeOnnxDecision(
        {
          modelId: context.model,
          state: batch.state,
          questions: batch.questions,
          signal: context.signal,
          isAdmissible: context.isAdmissible,
        },
        client,
        warn,
      );
    },
  };
}

export function createPreparedOnnxProvider(
  client: Pick<InferenceWorkerClient, "classify">,
  warn: (message: string) => void,
): DecisionProviderV2 {
  return {
    id: "onnx",
    contractVersion: 2,
    provider: {
      label: "ONNX",
      auth: [],
      authScope: "plugin",
      // This local marker satisfies the common auth contract; it never reaches a network.
      resolveSyntheticAuth: () => ({
        apiKey: "onnx-local",
        source: "onnx plugin",
        mode: "api-key",
      }),
      augmentModelCatalog: ({ entries }) => {
        const models: typeof entries = [];
        for (const entry of entries) {
          if (entry.provider !== "onnx") {
            continue;
          }
          const inference = entry.inference;
          // Canonical route facts win. Enrich only the documented V1 manifest input,
          // preserving each model's token scope, limits, and billing declarations.
          if (!inference?.decision || inference.decision.protocol !== "decision-v1") {
            models.push(entry);
            continue;
          }
          const decision = inference.decision;
          models.push({
            ...entry,
            inference: {
              ...inference,
              decision: {
                ...decision,
                protocol: "onnx-classifier",
                questions: {
                  boolean: {
                    ...decision.questions?.boolean,
                    probabilities: "boolean",
                    abstention: false,
                    requiresCriteria: true,
                  },
                  choice: {
                    ...decision.questions?.choice,
                    probabilities: "categorical",
                    abstention: false,
                    minOptions: 2,
                  },
                  score: {
                    ...decision.questions?.score,
                    probabilities: "categorical",
                    abstention: false,
                    minOptions: 2,
                  },
                },
                reasoning: { modes: ["auto"] },
              },
            },
          });
        }
        return models;
      },
    },
    async evaluate(batch, context) {
      if (
        !isDecisionBatchV1Representable(batch) ||
        (context.reasoning !== undefined && context.reasoning !== "auto")
      ) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const outcome = await executeOnnxDecision(
        {
          modelId: context.model.id,
          state: batch.state.type === "text" ? batch.state.text : batch.state.value,
          questions: batch.questions,
          signal: context.signal,
          isAdmissible: context.isAdmissible,
        },
        client,
        warn,
      );
      if (outcome.status !== "ok") {
        return outcome;
      }
      return validateDecisionResultV2(batch, outcome.result)
        ? outcome
        : { status: "unavailable", reason: "invalid-response" };
    },
  };
}
