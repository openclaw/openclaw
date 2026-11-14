import type {
  DecisionEntry,
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

export async function executeOnnxDecision(
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
