import {
  decodeSystemOneResponse,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const text = (value: DecisionBatchV2["questions"][string]["instructions"]): string =>
  value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);

// Native contract: https://docs.parallel.ai/api-reference/decisions/decisions
// This is a typed, web-grounded endpoint, not a chat-completions model.
export function encodeParallelDecisionRequest(batch: DecisionBatchV2): string | undefined {
  const entries = Object.entries(batch.questions);
  if (
    (batch.state.type !== "text" && batch.state.type !== "json") ||
    entries.length < 1 ||
    entries.length > 100 ||
    entries.some(([id]) => !/^[A-Za-z0-9_-]+$/.test(id))
  ) {
    return undefined;
  }
  const questions: [string, unknown][] = [];
  for (const [id, question] of entries) {
    if (!["boolean", "choice", "score"].includes(question.type)) {
      return undefined;
    }
    if (question.type === "choice") {
      const options = Object.entries(question.criteria);
      if (options.length < 2 || options.length > 255) {
        return undefined;
      }
      questions.push([
        id,
        {
          type: "choice",
          instructions: text(question.instructions),
          criteria: Object.fromEntries(options.map(([key, value]) => [key, text(value)])),
        },
      ]);
    } else if (question.type === "score") {
      if (question.criteria.length < 2 || question.criteria.length > 10) {
        return undefined;
      }
      questions.push([
        id,
        {
          type: "score",
          instructions: text(question.instructions),
          criteria: question.criteria.map(text),
        },
      ]);
    } else if (question.type === "boolean") {
      questions.push([
        id,
        {
          type: "noul",
          instructions: text(question.instructions),
          ...(question.criteria
            ? {
                criteria: {
                  true: text(question.criteria.true),
                  false: text(question.criteria.false),
                },
              }
            : {}),
        },
      ]);
    }
  }
  return JSON.stringify({
    mode: "fast",
    state: batch.state.type === "text" ? batch.state.text : batch.state.value,
    questions: Object.fromEntries(questions),
  });
}

export function decodeParallelDecisionResult(
  batch: DecisionBatchV2,
  responseValue: unknown,
  capabilities: Parameters<typeof validateDecisionResultV2>[2],
): ProviderDecisionOutcomeV2 {
  const invalid = { status: "unavailable", reason: "invalid-response" } as const;
  const root = asOptionalRecord(responseValue);
  if (
    !root ||
    root.mode !== "fast" ||
    typeof root.decision_id !== "string" ||
    !Array.isArray(root.citations)
  ) {
    return invalid;
  }
  if (
    !root.citations.every((value: unknown) => {
      const citation = asOptionalRecord(value);
      return (
        citation &&
        typeof citation.url === "string" &&
        (citation.title === undefined || typeof citation.title === "string") &&
        Array.isArray(citation.excerpts) &&
        citation.excerpts.every((excerpt: unknown) => typeof excerpt === "string")
      );
    })
  ) {
    return invalid;
  }
  const decoded = asOptionalRecord(
    decodeSystemOneResponse(
      batch,
      { ...root, model: "parallel/decisions-fast" },
      { confidence: "optional" },
    ),
  );
  if (!decoded) {
    return invalid;
  }
  const result: unknown = {
    ...decoded,
    usage: { ...asOptionalRecord(decoded.usage), units: { unit: "requests", amount: 1 } },
    // Citations belong to the whole request, not individual answers.
    metadata: {
      ...asOptionalRecord(decoded.metadata),
      decisionId: root.decision_id,
      citations: root.citations,
    },
  };
  return validateDecisionResultV2(batch, result, capabilities) ? { status: "ok", result } : invalid;
}
