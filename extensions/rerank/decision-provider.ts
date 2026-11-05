import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  DecisionProviderV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { validateDecisionResultV2 } from "openclaw/plugin-sdk/decisions";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import {
  fetchWithProviderHttpGuard,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  resolveProviderTransportSsrFPolicy,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  decodeRerankDecision,
  planRerankDecision,
  readRerankScores,
  type RerankRequest,
} from "./decision-codec.js";

export const RERANK_PROVIDER_ID = "rerank";
const MAX_RESPONSE_BYTES = 1_048_576;

/**
 * Field that carries the documents. Cohere, Jina, Voyage, vLLM, Infinity and
 * llama.cpp read `documents`; Hugging Face TEI reads `texts`. The first
 * rejected request per endpoint retries once with `texts` and remembers it.
 */
type DocumentsField = "documents" | "texts";
const documentsFieldByUrl = new Map<string, DocumentsField>();

type Transport = Pick<
  Parameters<typeof fetchWithProviderHttpGuard>[0],
  "url" | "policy" | "dispatcherPolicy"
> & { headers: HeadersInit };

function prepareTransport(context: DecisionProviderContextV2): Transport | undefined {
  const configured = context.config.models?.providers?.[RERANK_PROVIDER_ID];
  const baseUrl = context.model.baseUrl ?? configured?.baseUrl;
  if (!baseUrl) {
    return undefined;
  }
  const configuredRequest = configured?.request;
  // The host owns credential selection and auth overrides; do not resolve auth again.
  const request = sanitizeConfiguredModelProviderRequest(
    configuredRequest
      ? {
          proxy: configuredRequest.proxy,
          tls: configuredRequest.tls,
          allowPrivateNetwork: configuredRequest.allowPrivateNetwork,
        }
      : undefined,
  );
  const apiKey = context.auth.apiKey;
  const requestConfig = resolveProviderHttpRequestConfig({
    provider: RERANK_PROVIDER_ID,
    capability: "llm",
    transport: "http",
    baseUrl,
    defaultBaseUrl: baseUrl,
    defaultHeaders: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // Keyless local servers resolve to the synthetic marker; never send it.
      ...(apiKey &&
      apiKey !== CUSTOM_LOCAL_AUTH_MARKER &&
      (!configuredRequest?.auth || configuredRequest.auth.mode === "provider-default")
        ? { Authorization: `Bearer ${apiKey}` }
        : {}),
    },
    headers: context.model.headers,
    request,
  });
  const url = requestConfig.baseUrl.replace(/\/+$/u, "") + "/rerank";
  return {
    url,
    headers: requestConfig.headers,
    // A rerank endpoint is authored by the operator, usually on the LAN; trust
    // its origin unless the operator explicitly turned private networks off.
    policy: resolveProviderTransportSsrFPolicy({
      baseUrl: requestConfig.baseUrl,
      url,
      allowPrivateNetwork: requestConfig.allowPrivateNetwork,
      trustConfiguredBaseUrlOrigin: configuredRequest?.allowPrivateNetwork !== false,
    }),
    dispatcherPolicy: requestConfig.dispatcherPolicy,
  };
}

type Execution = Pick<DecisionProviderContextV2, "signal" | "deadlineMonotonicMs" | "isAdmissible">;

function failureReason(status: number): ProviderDecisionOutcomeV2 & { status: "unavailable" } {
  return {
    status: "unavailable",
    reason:
      status === 401 || status === 403
        ? "authentication"
        : status === 429
          ? "rate-limited"
          : [400, 413, 422].includes(status)
            ? "unsupported-input"
            : "transport",
  };
}

async function rerank(
  modelId: string,
  call: RerankRequest,
  transport: Transport,
  execution: Execution & { assertActive: () => void },
): Promise<number[] | ProviderDecisionOutcomeV2> {
  const known = documentsFieldByUrl.get(transport.url);
  const fields: DocumentsField[] = known ? [known] : ["documents", "texts"];
  let last: ProviderDecisionOutcomeV2 = { status: "unavailable", reason: "transport" };
  for (const field of fields) {
    execution.assertActive();
    const guarded = await fetchWithProviderHttpGuard({
      url: transport.url,
      init: {
        method: "POST",
        headers: transport.headers,
        body: JSON.stringify({ model: modelId, query: call.query, [field]: call.documents }),
      },
      signal: execution.signal,
      timeoutMs: execution.deadlineMonotonicMs - performance.now(),
      beforeRequest: execution.assertActive,
      policy: transport.policy,
      dispatcherPolicy: transport.dispatcherPolicy,
      auditContext: "rerank-decisions",
    });
    try {
      const response = guarded.response;
      if (!response.ok) {
        // Error bodies can echo request content; never read or surface them.
        await response.body?.cancel();
        last = failureReason(response.status);
        if (response.status === 400 || response.status === 422) {
          continue;
        }
        return last;
      }
      let payload: unknown;
      try {
        payload = await readProviderJsonResponse(response, "Rerank decisions", {
          maxBytes: MAX_RESPONSE_BYTES,
          timeoutMs: Math.max(1, execution.deadlineMonotonicMs - performance.now()),
        });
      } catch {
        execution.signal.throwIfAborted();
        return { status: "unavailable", reason: "invalid-response" };
      }
      const scores = readRerankScores(payload, call.documents.length);
      if (!scores) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      documentsFieldByUrl.set(transport.url, field);
      return scores;
    } finally {
      await guarded.release();
    }
  }
  return last;
}

async function evaluateRerankDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  const plan = planRerankDecision(batch);
  if (!plan || context.model.provider !== RERANK_PROVIDER_ID) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  let admissionError: { error: unknown } | undefined;
  const assertActive = () => {
    context.signal.throwIfAborted();
    let admitted: boolean;
    try {
      admitted = context.isAdmissible();
    } catch (error) {
      admissionError = { error };
      throw error;
    }
    if (!admitted || performance.now() >= context.deadlineMonotonicMs) {
      throw new Error("Rerank Decision is no longer admitted.");
    }
  };
  try {
    assertActive();
    const transport = prepareTransport(context);
    if (!transport) {
      return { status: "unavailable", reason: "unsupported-input" };
    }
    const scores: number[][] = [];
    for (const call of plan.requests) {
      const result = await rerank(context.model.id, call, transport, {
        signal: context.signal,
        deadlineMonotonicMs: context.deadlineMonotonicMs,
        isAdmissible: context.isAdmissible,
        assertActive,
      });
      if (!Array.isArray(result)) {
        return result;
      }
      scores.push(result);
    }
    assertActive();
    const result = { model: context.model.id, answers: decodeRerankDecision(plan, scores) };
    return validateDecisionResultV2(batch, result, context.model.inference?.decision)
      ? { status: "ok", result }
      : { status: "unavailable", reason: "invalid-response" };
  } catch {
    context.signal.throwIfAborted();
    if (admissionError) {
      throw admissionError.error;
    }
    return { status: "unavailable", reason: "transport" };
  }
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
