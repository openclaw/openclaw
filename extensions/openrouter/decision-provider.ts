import type {
  DecisionBatchV2,
  DecisionProviderV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import {
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  decodeOpenRouterDecisionResult,
  encodeOpenRouterDecisionRequest,
  isOpenRouterDecisionModel,
  supportsOpenRouterDecisionBatch,
} from "./decision-codec.js";
import {
  OPENROUTER_BASE_URL,
  resolveOpenRouterApiBaseUrl,
  resolveOpenRouterSsrfPolicy,
} from "./provider-catalog.js";
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
      let release: (() => Promise<void>) | undefined;
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
          throw new Error("OpenRouter decision is no longer admitted.");
        }
      };
      try {
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
        const timeoutMs = context.deadlineMonotonicMs - performance.now();
        context.signal.throwIfAborted();
        if (timeoutMs <= 0) {
          return { status: "unavailable", reason: "transport" };
        }
        const guarded = await fetchWithSsrFGuard({
          // Append to the effective API prefix; custom proxies must never escape to the canonical host.
          url: requestConfig.baseUrl + "/systemone",
          init: { method: "POST", headers: requestConfig.headers, body: JSON.stringify(body) },
          signal: context.signal,
          timeoutMs,
          // DNS, proxy and capture preparation can yield after the host handed us
          // this context. Recheck its live authority at each physical dispatch.
          beforeRequest: assertActive,
          policy: resolveOpenRouterSsrfPolicy(requestConfig, configuredRequest),
          dispatcherPolicy: requestConfig.dispatcherPolicy,
          auditContext: "openrouter-decisions",
        });
        release = guarded.release;
        const response = guarded.response;
        if (!response.ok) {
          return {
            status: "unavailable",
            reason:
              response.status === 401 || response.status === 403
                ? "authentication"
                : response.status === 429 || response.status === 529
                  ? "rate-limited"
                  : [400, 413, 422].includes(response.status)
                    ? "unsupported-input"
                    : "transport",
          };
        }
        let value: unknown;
        try {
          value = await readProviderJsonResponse(response, "OpenRouter decisions", {
            maxBytes: 1_048_576,
            timeoutMs: Math.max(1, context.deadlineMonotonicMs - performance.now()),
          });
        } catch {
          context.signal.throwIfAborted();
          return { status: "unavailable", reason: "invalid-response" };
        }
        context.signal.throwIfAborted();
        return decodeOpenRouterDecisionResult(batch, value, context.model.inference?.decision);
      } catch {
        context.signal.throwIfAborted();
        if (admissionError) {
          throw admissionError.error;
        }
        return { status: "unavailable", reason: "transport" };
      } finally {
        await release?.();
      }
    },
  };
}
