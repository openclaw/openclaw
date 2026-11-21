import { getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  decodeTextSystemOneResponse,
  encodeTextSystemOneRequest,
  type DecisionBatchV2,
  type DecisionProviderContextV2,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { executeDecisionJsonRequest } from "openclaw/plugin-sdk/decisions-unary-runtime";
import { createProviderCredentialMatcher } from "openclaw/plugin-sdk/provider-http";
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import { normalizeClawRouterApiBaseUrl } from "./base-url.js";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
  type ClawRouterCapabilityOffer,
} from "./capability-offers.js";
import { readBasetenDecisionOffer } from "./decision-baseten-offers.js";

function supported(batch: DecisionBatchV2, reasoning: DecisionProviderContextV2["reasoning"]) {
  if (
    !["text", "json"].includes(batch.state.type) ||
    (reasoning !== undefined && reasoning !== "auto")
  ) {
    return false;
  }
  let options = 0;
  for (const question of Object.values(batch.questions)) {
    if (question.type === "boolean") {
      options += 2;
    } else if (question.type === "choice") {
      const count = Object.keys(question.criteria).length;
      if (count < 2 || count > 255) {
        return false;
      }
      options += count;
    } else if (question.type === "score") {
      if (question.criteria.length < 2 || question.criteria.length > 10) {
        return false;
      }
      options += question.criteria.length;
    } else {
      return false;
    }
  }
  return options > 0 && options <= 512;
}

export async function evaluateClawRouterBasetenDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (context.model.provider !== "clawrouter" || !supported(batch, context.reasoning)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const auth = context.auth;
  if (auth.mode !== "api-key" || !auth.apiKey) {
    return { status: "unavailable", reason: "credentials-unavailable" };
  }
  if (!context.isAdmissible() || performance.now() >= context.deadlineMonotonicMs) {
    return { status: "unavailable", reason: "transport" };
  }
  const provider = context.config.models?.providers?.clawrouter;
  const baseUrl = normalizeClawRouterApiBaseUrl(provider?.baseUrl);
  if (context.model.baseUrl && normalizeClawRouterApiBaseUrl(context.model.baseUrl) !== baseUrl) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const prepared = getModelProviderRequestTransport(context.model);
  const http = resolveClawRouterCapabilityHttpContext(
    {
      ...context.config,
      models: {
        ...context.config.models,
        providers: {
          ...context.config.models?.providers,
          clawrouter: {
            ...provider,
            models: provider?.models ?? [],
            baseUrl,
            headers: context.model.headers
              ? omitNullRequestHeaders(context.model.headers)
              : provider?.headers,
            request: prepared
              ? {
                  proxy: prepared.proxy,
                  tls: prepared.tls,
                  allowPrivateNetwork: prepared.allowPrivateNetwork,
                }
              : provider?.request,
          },
        },
      },
    },
    auth.apiKey,
  );
  http.headers.delete("x-api-key");
  const timeoutMs = () => Math.max(1, context.deadlineMonotonicMs - performance.now());
  let offers: ClawRouterCapabilityOffer[];
  try {
    offers = await fetchClawRouterCapabilityOffers({
      context: http,
      timeoutMs,
      signal: context.signal,
      requireFreshProxyCatalog: true,
    });
  } catch {
    context.signal.throwIfAborted();
    return { status: "unavailable", reason: "transport" };
  }
  context.signal.throwIfAborted();
  if (!context.isAdmissible() || performance.now() >= context.deadlineMonotonicMs) {
    return { status: "unavailable", reason: "transport" };
  }
  const qualified = offers
    .map(readBasetenDecisionOffer)
    .find((row) => row?.offer.model?.id === context.model.id);
  if (
    !qualified ||
    JSON.stringify(qualified.inference.decision) !==
      JSON.stringify(context.model.inference?.decision)
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const nativeBody = encodeTextSystemOneRequest(batch, qualified.upstream);
  if (Buffer.byteLength(nativeBody) > 4 * 1024 * 1024) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const body =
    qualified.offer.routeKind === "manifest"
      ? JSON.stringify({ body: JSON.parse(nativeBody) })
      : nativeBody;
  http.headers.set("Content-Type", "application/json");
  return executeDecisionJsonRequest({
    body,
    apiKey: auth.apiKey,
    successStatus: 200,
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
    prepareTransport: () => ({
      ...http,
      url: qualified.offer.url,
      reflectsCredential: createProviderCredentialMatcher({
        headers: http.headers,
        defaultAuthHeader: "Authorization",
        defaultAuthPrefix: "Bearer ",
      }),
    }),
    decode: (payload) => decodeTextSystemOneResponse(batch, payload),
  });
}
