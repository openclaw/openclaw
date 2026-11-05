import {
  decodeSystemOneResponse,
  encodeSystemOneQuestions,
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";

// Liquid's documented complete JSON-body limit includes base64, state and questions.
const MAX_REQUEST_BYTES = 4_500_000;

export function supportsLiquidDecisionBatch(batch: DecisionBatchV2): boolean {
  if (!validateDecisionBatchV2(batch) || batch.state.type === "list") {
    return false;
  }
  if (
    batch.state.type === "json" &&
    (batch.state.value === null ||
      (typeof batch.state.value !== "string" && typeof batch.state.value !== "object"))
  ) {
    return false;
  }
  return Object.values(batch.questions).every((question) => {
    if (question.type === "boolean") {
      return (
        question.instructions != null ||
        Object.values(question.criteria ?? {}).some((value) => value != null)
      );
    }
    return question.type === "choice" || question.type === "score";
  });
}

export function encodeLiquidDecisionRequest(
  batch: DecisionBatchV2,
  modelId: string,
): string | undefined {
  const body = JSON.stringify({
    model: modelId,
    state:
      batch.state.type === "text"
        ? batch.state.text
        : batch.state.type === "json"
          ? batch.state.value
          : batch.state.type === "image"
            ? (batch.state.text ?? "")
            : undefined,
    ...(batch.state.type === "image" ? { images: [batch.state.dataUri] } : {}),
    questions: encodeSystemOneQuestions(batch),
  });
  return Buffer.byteLength(body) >= MAX_REQUEST_BYTES ? undefined : body;
}

export function supportsLiquidImageDimensions(
  metadata: { width: number; height: number } | null,
): boolean {
  return !(
    !metadata ||
    metadata.width <= 0 ||
    metadata.height <= 0 ||
    Math.max(metadata.width, metadata.height) > 100 * Math.min(metadata.width, metadata.height) ||
    Math.ceil(metadata.width / 32) * Math.ceil(metadata.height / 32) > 10_000
  );
}

export function decodeLiquidDecisionResult(
  batch: DecisionBatchV2,
  value: unknown,
  capabilities: Parameters<typeof validateDecisionResultV2>[2],
): ProviderDecisionOutcomeV2 {
  const result = decodeSystemOneResponse(batch, value);
  return validateDecisionResultV2(batch, result, capabilities) && result.usage?.outputTokens === 0
    ? { status: "ok", result }
    : { status: "unavailable", reason: "invalid-response" };
}
