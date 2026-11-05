import type {
  DecisionBatchV2,
  DecisionProviderV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import {
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  encodeOpenRouterDecisionRequest,
  isOpenRouterDecisionModel,
  supportsOpenRouterDecisionBatch,
} from "./decision-codec.js";
import { executeOpenRouterDecision } from "./decision-execution.js";
import { OPENROUTER_BASE_URL, resolveOpenRouterApiBaseUrl } from "./provider-catalog.js";
import {
  resolveOpenRouterConfiguredExtraParams,
  resolveOpenRouterExtraParamsForTransport,
} from "./provider-routing.js";

function unsupported(): ProviderDecisionOutcomeV2 {
  return { status: "unavailable", reason: "unsupported-input" };
}

function buildRequest(batch: DecisionBatchV2, context: DecisionProviderContextV2) {
  const extraParams =
    resolveOpenRouterConfiguredExtraParams({
      config: context.config,
      agentId: context.agentId,
      modelId: context.model.id,
    }) ?? {};
  const routed =
    resolveOpenRouterExtraParamsForTransport({
      config: context.config,
      provider: "openrouter",
      model: context.model,
      extraParams,
    })?.patch ?? extraParams;
  // This route only documents provider preferences. Do not silently drop configured
  // parameter limits, privacy settings or unsupported chat controls.
  if (routed && Object.keys(routed).some((key) => key !== "provider")) {
    return undefined;
  }
  return encodeOpenRouterDecisionRequest(batch, context.model.id, routed?.provider);
}

export function buildOpenRouterDecisionProvider(): DecisionProviderV2 {
  return {
    id: "openrouter",
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      if (
        !isOpenRouterDecisionModel(context.model.id) ||
        (context.reasoning !== undefined && context.reasoning !== "auto") ||
        !supportsOpenRouterDecisionBatch(batch, context.model.id)
      ) {
        return unsupported();
      }
      const body = buildRequest(batch, context);
      if (!body) {
        return unsupported();
      }
      if (!context.auth.apiKey && !context.model.headers) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const providerConfig = context.config.models?.providers?.openrouter;
      return executeOpenRouterDecision(batch, {
        body,
        signal: context.signal,
        deadlineMonotonicMs: context.deadlineMonotonicMs,
        isAdmissible: context.isAdmissible,
        capabilities: context.model.inference?.decision,
        prepareTransport: () => {
          // Auth and effective headers are prepared by the host. Only proxy/TLS/SSRF
          // policy is read here; never select a second credential or auth profile.
          const configuredRequest = providerConfig?.request;
          const request = sanitizeConfiguredModelProviderRequest(
            configuredRequest
              ? {
                  proxy: configuredRequest.proxy,
                  tls: configuredRequest.tls,
                  allowPrivateNetwork: configuredRequest.allowPrivateNetwork,
                }
              : undefined,
          );
          const requestConfig = resolveProviderHttpRequestConfig({
            provider: "openrouter",
            capability: "llm",
            transport: "http",
            baseUrl: resolveOpenRouterApiBaseUrl(context.model.baseUrl ?? providerConfig?.baseUrl),
            defaultBaseUrl: OPENROUTER_BASE_URL,
            defaultHeaders: {
              "Content-Type": "application/json",
              // The host already applied an explicit auth override to its private headers.
              // Do not restore the provider-default bearer after a custom header replaced it.
              ...(context.auth.apiKey &&
              (!configuredRequest?.auth || configuredRequest.auth.mode === "provider-default")
                ? { Authorization: `Bearer ${context.auth.apiKey}` }
                : {}),
            },
            headers: context.model.headers,
            request,
          });
          return {
            requestConfig,
            configuredRequest: configuredRequest
              ? { allowPrivateNetwork: configuredRequest.allowPrivateNetwork }
              : undefined,
          };
        },
      });
    },
  };
}
