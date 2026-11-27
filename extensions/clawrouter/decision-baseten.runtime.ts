import { getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  decodeTextSystemOneResponse,
  encodeTextSystemOneRequest,
  type DecisionBatchV2,
  type DecisionProviderContextV2,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { executeDecisionJsonRequest } from "openclaw/plugin-sdk/decisions-unary-runtime";
import {
  createProviderCredentialMatcher,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
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

export function resolveBasetenDecisionHttpContext(
  context: DecisionProviderContextV2,
  apiKey: string,
) {
  const provider = context.config.models?.providers?.clawrouter;
  const prepared = getModelProviderRequestTransport(context.model);
  const configuredHeaders = context.model.headers
    ? omitNullRequestHeaders(context.model.headers)
    : provider?.headers;
  const request = prepared
    ? {
        proxy: prepared.proxy,
        tls: prepared.tls,
        allowPrivateNetwork: prepared.allowPrivateNetwork,
      }
    : provider?.request;
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
            headers: configuredHeaders,
            request,
          },
        },
      },
    },
    apiKey,
  );
  http.headers.delete("x-api-key");
  const credentialHeaders = new Headers(http.headers);
  for (const name of ["accept", "content-type", "x-clawrouter-client"]) {
    credentialHeaders.delete(name);
  }
  return {
    ...http,
    reflectsCredential: createProviderCredentialMatcher({
      headers: credentialHeaders,
      configuredHeaderNames: Object.keys(configuredHeaders ?? {}),
      request: prepared ?? sanitizeConfiguredModelProviderRequest(provider?.request),
      defaultAuthHeader: "Authorization",
      defaultAuthPrefix: "Bearer ",
    }),
  };
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
  const http = resolveBasetenDecisionHttpContext(context, auth.apiKey);
  const timeoutMs = () => Math.max(1, context.deadlineMonotonicMs - performance.now());
  let admissionError: { error: unknown } | undefined;
  let offers: ClawRouterCapabilityOffer[];
  try {
    offers = await fetchClawRouterCapabilityOffers({
      context: http,
      timeoutMs,
      signal: context.signal,
      beforeRequest: () => {
        context.signal.throwIfAborted();
        let admitted: boolean;
        try {
          admitted = context.isAdmissible();
        } catch (error) {
          admissionError = { error };
          throw error;
        }
        if (!admitted || performance.now() >= context.deadlineMonotonicMs) {
          throw new Error("Baseten discovery is no longer admitted.");
        }
      },
      requireFreshProxyCatalog: true,
    });
  } catch {
    context.signal.throwIfAborted();
    if (admissionError) {
      throw admissionError.error;
    }
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
    }),
    decode: (payload) => decodeTextSystemOneResponse(batch, payload),
  });
}
