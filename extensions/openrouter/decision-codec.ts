import {
  decodeSystemOneResponse,
  encodeSystemOneQuestions,
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";

export function isOpenRouterDecisionModel(modelId: string): boolean {
  return (
    modelId === "typesafe/jev-1.13" ||
    modelId === "typesafe/jev-1.14" ||
    modelId === "~typesafe/jev-latest"
  );
}

export function supportsOpenRouterDecisionBatch(batch: DecisionBatchV2, modelId: string): boolean {
  if (!validateDecisionBatchV2(batch)) {
    return false;
  }
  // Jev accepts PNG/JPEG only. The shared validator bounds and checks inline data;
  // neither this adapter nor the host fetches image URLs or resizes caller evidence.
  if (
    batch.state.type !== "image" &&
    batch.state.type !== "text" &&
    (batch.state.type !== "json" ||
      batch.state.value === null ||
      (typeof batch.state.value !== "object" && typeof batch.state.value !== "string"))
  ) {
    return false;
  }
  if (
    batch.state.type === "image" &&
    !/^data:image\/(?:png|jpeg);base64,/.test(batch.state.dataUri)
  ) {
    return false;
  }
  return Object.values(batch.questions).every((q) => {
    if (q.type === "sort" || q.type === "tags" || q.instructions == null) {
      return false;
    }
    if (q.type === "box") {
      return modelId !== "typesafe/jev-1.13";
    }
    if (q.type === "choice") {
      return Object.keys(q.criteria).length <= 255;
    }
    if (q.type === "score") {
      return q.criteria.length <= 10 && q.criteria.every((entry) => entry !== null);
    }
    return (
      q.criteria === undefined ||
      (q.criteria !== null && q.criteria.true != null && q.criteria.false != null)
    );
  });
}

export function encodeOpenRouterDecisionRequest(
  batch: DecisionBatchV2,
  modelId: string,
  provider: unknown,
) {
  return {
    model: modelId,
    state:
      batch.state.type === "text"
        ? batch.state.text
        : batch.state.type === "json"
          ? batch.state.value
          : batch.state.type === "image"
            ? [
                ...(batch.state.text === undefined ? [] : [batch.state.text]),
                { type: "image_url", image_url: { url: batch.state.dataUri } },
              ]
            : undefined,
    questions: encodeSystemOneQuestions(batch),
    ...(provider !== undefined ? { provider } : {}),
  };
}

export function decodeOpenRouterDecisionResult(
  batch: DecisionBatchV2,
  value: unknown,
  capabilities: Parameters<typeof validateDecisionResultV2>[2],
): ProviderDecisionOutcomeV2 {
  const result = decodeSystemOneResponse(batch, value);
  return validateDecisionResultV2(batch, result, capabilities)
    ? { status: "ok", result }
    : { status: "unavailable", reason: "invalid-response" };
}
