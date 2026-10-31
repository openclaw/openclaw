import {
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionAnswerV2,
  type DecisionBatchV2,
  type DecisionQuestionV2,
  type JsonValue,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import type {
  SageBatchRequest,
  SageBatchResponse,
  SageContent,
  SageQuestion,
  SageRequest,
  SageResponse,
} from "./sage-wire.js";

function render(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
function content(state: DecisionBatchV2["state"]): SageContent {
  switch (state.type) {
    case "text":
      return state.text;
    case "json":
      return render(state.value);
    case "image":
      return {
        kind: "image",
        media: state.dataUri,
        ...(state.text === undefined ? {} : { text: state.text }),
      };
    case "list":
      return {
        kind: "list",
        value: state.items.map((item) => ({ id: item.id, content: render(item.content) })),
      };
  }
  throw new Error("Unsupported Sage content");
}
function question(id: string, q: DecisionQuestionV2): SageQuestion {
  const instructions = q.instructions == null ? id : render(q.instructions);
  switch (q.type) {
    case "boolean":
      return {
        id,
        kind: "yesno",
        instructions:
          q.criteria == null
            ? instructions
            : instructions +
              "\nCriteria (true means yes; false means no):\n" +
              JSON.stringify(q.criteria),
      };
    case "choice":
      return {
        id,
        kind: "choice",
        instructions,
        options: Object.entries(q.criteria).map(([option, description]) => ({
          option,
          description: description === null ? null : render(description),
        })),
      };
    case "score":
      return {
        id,
        kind: "scale",
        instructions,
        levels: q.criteria.map((description, level) => ({
          level,
          description: description === null ? null : render(description),
        })),
      };
    case "sort":
      return { id, kind: "sort", instructions };
    case "tags":
      return {
        id,
        kind: "tags",
        ...(q.instructions == null ? {} : { instructions }),
        tags: Object.entries(q.criteria).map(([tagId, description]) =>
          description === null ? { id: tagId } : { id: tagId, name: render(description) },
        ),
      };
    case "box":
      break;
  }
  throw new Error("Unsupported Sage question");
}
function answer(response: SageResponse): DecisionAnswerV2 {
  const metadata = { native: response };
  switch (response.kind) {
    case "yesno":
      return {
        type: "boolean",
        answer: response.result.answer === null ? null : response.result.answer === "yes",
        probabilityTrue: response.result.probability,
        metadata,
      };
    case "choice":
      return {
        type: "choice",
        choice: response.result.chosen,
        probability: response.result.probability,
        probabilities: Object.fromEntries(
          response.result.probabilities.map((p) => [p.option, p.probability]),
        ),
        metadata,
      };
    case "scale":
      return {
        type: "score",
        score: response.result.expectation,
        confidence: response.result.confidence,
        probabilities: response.result.probabilities.map((entry) => entry.probability),
        metadata,
      };
    case "sort":
      return {
        type: "sort",
        order: response.result.sorted,
        ...(response.result.confidence === undefined
          ? {}
          : { confidence: response.result.confidence }),
        metadata,
      };
    case "tags":
      return { type: "tags", tags: response.result.tags, metadata };
  }
  throw new Error("Unsupported Sage response");
}

export function encodeSageDecisionInput(batch: DecisionBatchV2) {
  if (!validateDecisionBatchV2(batch)) {
    return undefined;
  }
  if (batch.state.type === "list" && batch.state.items.length < 2) {
    return undefined;
  }
  const nativeContent = content(batch.state);
  const questions = Object.entries(batch.questions).map(([id, q]) => question(id, q));
  // Enforce vendor limits absent from the admitted Decision contract.
  for (const q of questions) {
    if (
      (q.kind === "scale" && q.levels.length > 26) ||
      (q.kind === "choice" && q.options.length > (batch.state.type === "image" ? 20 : 120)) ||
      (q.kind === "tags" && q.tags.length > 120)
    ) {
      return undefined;
    }
  }
  return { nativeContent, questions };
}

export function encodeSageDecisionRequest(
  nativeContent: SageContent,
  questions: SageQuestion[],
  mode: SageRequest["reasoning"],
): SageRequest | SageBatchRequest | undefined {
  const reasoning = mode === undefined ? {} : { reasoning: mode };
  const first = questions[0];
  if (!first) {
    return undefined;
  }
  return questions.length === 1
    ? { content: nativeContent, question: first, ...reasoning }
    : { requests: [{ content: nativeContent, questions }], ...reasoning };
}

export function decodeSageDecisionResult(
  batch: DecisionBatchV2,
  questions: SageQuestion[],
  response: SageResponse | SageBatchResponse,
  modelId: string,
  capabilities: Parameters<typeof validateDecisionResultV2>[2],
): ProviderDecisionOutcomeV2 {
  const answers: Record<string, DecisionAnswerV2> = Object.create(null);
  if ("results" in response) {
    const group = response.results[0];
    if (!group) {
      return { status: "unavailable", reason: "invalid-response" };
    }
    questions.forEach((q, index) => {
      const item = group.answers[index];
      if (!item) {
        throw new Error("Missing Sage answer");
      }
      answers[q.id] = item.ok ? answer(item.result) : { type: "error", code: "provider-error" };
    });
  } else {
    answers[response.id] = answer(response);
  }
  const usage = response.meta.usage;
  const result = {
    model: response.meta.model ?? modelId,
    answers,
    ...(usage
      ? {
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            raw: usage,
          },
        }
      : {}),
    // Call-level accounting and partial error text stay on an object, never array.meta.
    metadata: { native: response },
  };
  return validateDecisionResultV2(batch, result, capabilities)
    ? { status: "ok", result }
    : { status: "unavailable", reason: "invalid-response" };
}
