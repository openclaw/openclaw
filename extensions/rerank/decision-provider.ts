import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  DecisionProviderV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { validateDecisionResultV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { decodeRerankDecision, planRerankDecision, readRerankScores } from "./decision-codec.js";

export const RERANK_PROVIDER_ID = "rerank";
const loadDecisionHttp = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/decisions-http-runtime"),
);

/**
 * Field that carries the documents. Cohere, Jina, Voyage, vLLM, Infinity and
 * llama.cpp read `documents`; Hugging Face TEI reads `texts`. The first
 * rejected request per endpoint retries once with `texts` and remembers it.
 */
const documentsFieldByUrl = new Map<string, "documents" | "texts">();

async function evaluateRerankDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  const plan = planRerankDecision(batch);
  const baseUrl =
    context.model.baseUrl ?? context.config.models?.providers?.[RERANK_PROVIDER_ID]?.baseUrl;
  if (!plan || context.model.provider !== RERANK_PROVIDER_ID || !baseUrl) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const { evaluateDecisionHttp } = await loadDecisionHttp();
  const scores: number[][] = [];
  for (const call of plan.requests) {
    // Each request, including the field retry, checks admission when it starts.
    const request = (field: "documents" | "texts") =>
      evaluateDecisionHttp<number[]>(context, {
        provider: RERANK_PROVIDER_ID,
        baseUrl,
        endpointPath: "rerank",
        body: JSON.stringify({
          model: context.model.id,
          query: call.query,
          [field]: call.documents,
        }),
        // Keyless local servers resolve to the synthetic marker; never send it.
        authHeaders: (apiKey): Record<string, string> =>
          apiKey === CUSTOM_LOCAL_AUTH_MARKER ? {} : { Authorization: `Bearer ${apiKey}` },
        decode: (payload) =>
          readRerankScores(payload, call.documents.length) ?? {
            status: "unavailable",
            reason: "invalid-response",
          },
      });
    const known = documentsFieldByUrl.get(baseUrl);
    let field = known ?? "documents";
    let result = await request(field);
    if (!known && !Array.isArray(result) && result.reason === "unsupported-input") {
      field = "texts";
      result = await request(field);
    }
    if (!Array.isArray(result)) {
      return result;
    }
    documentsFieldByUrl.set(baseUrl, field);
    scores.push(result);
  }
  const result = { model: context.model.id, answers: decodeRerankDecision(plan, scores) };
  return validateDecisionResultV2(batch, result, context.model.inference?.decision)
    ? { status: "ok", result }
    : { status: "unavailable", reason: "invalid-response" };
}

export function buildRerankDecisionProvider(): DecisionProviderV2 {
  return {
    id: RERANK_PROVIDER_ID,
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      return evaluateRerankDecision(batch, context);
    },
  };
}
