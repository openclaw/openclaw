import {
  isDecisionBatchV1Representable,
  validateDecisionResultV2,
} from "openclaw/plugin-sdk/decisions";
import type {
  DecisionEntry,
  DecisionProviderV1,
  DecisionProviderV2,
  DecisionQuestion,
  ProviderDecisionOutcome,
} from "openclaw/plugin-sdk/decisions";
import { findModel } from "./catalog.js";
import { decodeOnnxDecisionResults, encodeOnnxDecisionInputs } from "./decision-codec.js";
import { UnsupportedInputError } from "./models/types.js";
import { OnnxWorkerError } from "./protocol.js";
import type { InferenceWorkerClient } from "./worker-client.js";

type OnnxDecisionExecution = {
  readonly modelId: string;
  readonly state: DecisionEntry;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly signal: AbortSignal;
  readonly isAdmissible?: (() => boolean) | undefined;
};

async function executeOnnxDecision(
  execution: OnnxDecisionExecution,
  client: Pick<InferenceWorkerClient, "classify">,
  warn: (message: string) => void,
): Promise<ProviderDecisionOutcome> {
  execution.signal.throwIfAborted();
  if (!findModel(execution.modelId)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  try {
    const encoded = encodeOnnxDecisionInputs(execution.state, execution.questions);
    const results = await client.classify(
      execution.modelId,
      encoded.inputs,
      execution.signal,
      execution.isAdmissible,
    );
    execution.signal.throwIfAborted();
    return {
      status: "ok",
      result: decodeOnnxDecisionResults(execution.modelId, encoded, results),
    };
  } catch (error) {
    execution.signal.throwIfAborted();
    if (
      error instanceof UnsupportedInputError ||
      (error instanceof OnnxWorkerError && error.code === "unsupported-input")
    ) {
      return { status: "unavailable", reason: "unsupported-input" };
    }
    if (error instanceof OnnxWorkerError) {
      if (error.code === "model-missing" || error.code === "model-integrity") {
        warn(
          `ONNX model ${execution.modelId} is missing or invalid. Run openclaw onnx verify ${execution.modelId}; use download or prepare a local export as listed by openclaw onnx models.`,
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
}

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
