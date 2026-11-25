import {
  decodeSystemOneResponse,
  encodeSystemOneQuestions,
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type JsonValue,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function isParallelDecisionModel(modelId: string): boolean {
  return modelId === "parallel/decisions-fast" || modelId === "parallel/decisions-fast:free";
}

export function isOpenRouterDecisionModel(modelId: string): boolean {
  return (
    modelId === "typesafe/jev-1.13" ||
    modelId === "typesafe/jev-1.14" ||
    modelId === "~typesafe/jev-latest" ||
    isParallelDecisionModel(modelId)
  );
}

export function supportsOpenRouterDecisionBatch(batch: DecisionBatchV2, modelId: string): boolean {
  if (!validateDecisionBatchV2(batch)) {
    return false;
  }
  // Parallel is text/JSON-only, with at most 100 questions and no box output.
  // https://openrouter.ai/docs/guides/community/multimodal-decisions
  // https://docs.parallel.ai/decisions/question-types
  const parallel = isParallelDecisionModel(modelId);
  if (parallel && (batch.state.type === "image" || Object.keys(batch.questions).length > 100)) {
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
  // OpenRouter's normalized Decisions schema allows omitted confidence.
  const result = asOptionalRecord(
    decodeSystemOneResponse(batch, value, { confidence: "optional" }),
  );
  if (!result) {
    return { status: "unavailable", reason: "invalid-response" };
  }
  const record = asOptionalRecord(value);
  const annotations: JsonValue[] = [];
  if (record?.annotations !== undefined) {
    if (!Array.isArray(record.annotations)) {
      return { status: "unavailable", reason: "invalid-response" };
    }
    // Sources apply to the whole request, not to an individual answer.
    // https://openrouter.ai/openapi.json#/components/schemas/DecisionsUrlCitationAnnotation
    for (const annotationValue of record.annotations) {
      const annotation = asOptionalRecord(annotationValue);
      const citation = asOptionalRecord(annotation?.url_citation);
      if (
        annotation?.type !== "url_citation" ||
        typeof citation?.url !== "string" ||
        (citation.title !== undefined && typeof citation.title !== "string") ||
        (citation.content !== undefined && typeof citation.content !== "string")
      ) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      annotations.push({
        type: "url_citation",
        url_citation: {
          url: citation.url,
          ...(typeof citation.title === "string" ? { title: citation.title } : {}),
          ...(typeof citation.content === "string" ? { content: citation.content } : {}),
        },
      });
    }
  }
  const sourcedResult =
    record?.annotations !== undefined
      ? { ...result, metadata: { ...asOptionalRecord(result.metadata), annotations } }
      : result;
  return validateDecisionResultV2(batch, sourcedResult, capabilities)
    ? { status: "ok", result: sourcedResult }
    : { status: "unavailable", reason: "invalid-response" };
}
