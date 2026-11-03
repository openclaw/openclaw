import { getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  encodeTextSystemOneRequest,
  decodeTextSystemOneResponse,
  type DecisionBatchV2,
  type DecisionProviderContextV2,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { executeDecisionJsonRequest } from "openclaw/plugin-sdk/decisions-unary-runtime";
import {
  createProviderCredentialMatcher,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { BASETEN_BASE_URL, BASETEN_DECISION_MODEL_IDS } from "./models.js";

export async function evaluateBasetenDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (
    context.model.provider !== "baseten" ||
    !BASETEN_DECISION_MODEL_IDS.has(context.model.id) ||
    !["text", "json"].includes(batch.state.type) ||
    Object.values(batch.questions).some((q) => !["boolean", "choice", "score"].includes(q.type)) ||
    (context.reasoning !== undefined && context.reasoning !== "auto")
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const auth = context.auth;
  if (auth.mode !== "api-key" || !auth.apiKey) {
    return { status: "unavailable", reason: "credentials-unavailable" };
  }
  return executeDecisionJsonRequest({
    body: encodeTextSystemOneRequest(batch, context.model.id),
    decode: (payload) => decodeTextSystemOneResponse(batch, payload),
    apiKey: auth.apiKey,
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
    prepareTransport: () => {
      const preparedRequest = getModelProviderRequestTransport(context.model);
      const requestConfig = resolveProviderHttpRequestConfig({
        provider: "baseten",
        capability: "other",
        transport: "http",
        baseUrl: context.model.baseUrl ?? BASETEN_BASE_URL,
        defaultBaseUrl: BASETEN_BASE_URL,
        headers: context.model.headers,
        defaultHeaders: {
          ...(!preparedRequest?.auth || preparedRequest.auth.mode === "provider-default"
            ? { Authorization: `Bearer ${auth.apiKey}` }
            : {}),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        request: preparedRequest
          ? {
              proxy: preparedRequest.proxy,
              tls: preparedRequest.tls,
              allowPrivateNetwork: preparedRequest.allowPrivateNetwork,
            }
          : undefined,
      });
      return {
        ...requestConfig,
        url: requestConfig.baseUrl.replace(/\/$/, "") + "/systemone",
        reflectsCredential: createProviderCredentialMatcher({
          headers: requestConfig.headers,
          request: preparedRequest,
          configuredHeaderNames: Object.keys(context.model.headers ?? {}),
          defaultAuthHeader: "Authorization",
          defaultAuthPrefix: "Bearer ",
        }),
      };
    },
  });
}
