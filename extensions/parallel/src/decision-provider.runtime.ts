import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import {
  fetchWithProviderHttpGuard,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  resolveProviderTransportSsrFPolicy,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { decodeParallelDecisionResult, encodeParallelDecisionRequest } from "./decision-codec.js";

export async function evaluateParallelDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  const providerConfig = context.config.models?.providers?.parallel;
  const agent = context.agentId ? resolveAgentConfig(context.config, context.agentId) : undefined;
  const modelRef = "parallel/" + context.model.id;
  const hasParams = [
    providerConfig?.params,
    context.model.params,
    context.config.agents?.defaults?.params,
    context.config.agents?.defaults?.models?.[modelRef]?.params,
    agent?.models?.[modelRef]?.params,
    agent?.params,
  ].some((params) => Object.values(params ?? {}).some((value) => value !== undefined));
  const body = encodeParallelDecisionRequest(batch);
  // The native endpoint has no generation controls. Preserve authored limits/privacy
  // settings by refusing unsupported controls rather than silently dropping them.
  if (
    context.model.id !== "decisions-fast" ||
    (context.reasoning !== undefined && context.reasoning !== "auto") ||
    hasParams ||
    !body
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  if (!context.auth.apiKey && !context.model.headers) {
    return { status: "unavailable", reason: "credentials-unavailable" };
  }
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
      throw new Error("Parallel decision is no longer admitted.");
    }
  };
  try {
    assertActive();
    const configuredRequest = providerConfig?.request;
    // Credential selection and replacement auth already belong to the host. Only
    // carry network policy here; replaying auth would overwrite prepared headers.
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
      provider: "parallel",
      capability: "llm",
      transport: "http",
      defaultBaseUrl: "https://api.parallel.ai/v1",
      baseUrl: context.model.baseUrl ?? providerConfig?.baseUrl,
      defaultHeaders: {
        "Content-Type": "application/json",
        ...(context.auth.apiKey &&
        (!configuredRequest?.auth || configuredRequest.auth.mode === "provider-default")
          ? { "x-api-key": context.auth.apiKey }
          : {}),
      },
      headers: context.model.headers,
      request,
    });
    const url = requestConfig.baseUrl.replace(/\/+$/u, "") + "/decisions";
    const guarded = await fetchWithProviderHttpGuard({
      url,
      init: { method: "POST", headers: requestConfig.headers, body },
      signal: context.signal,
      timeoutMs: context.deadlineMonotonicMs - performance.now(),
      beforeRequest: assertActive,
      policy: resolveProviderTransportSsrFPolicy({
        baseUrl: requestConfig.baseUrl,
        url,
        allowPrivateNetwork: requestConfig.allowPrivateNetwork,
        trustConfiguredBaseUrlOrigin: configuredRequest?.allowPrivateNetwork !== false,
      }),
      dispatcherPolicy: requestConfig.dispatcherPolicy,
      auditContext: "parallel-decisions",
    });
    release = guarded.release;
    const response = guarded.response;
    if (!response.ok) {
      return {
        status: "unavailable",
        reason:
          response.status === 401 || response.status === 403
            ? "authentication"
            : response.status === 429
              ? "rate-limited"
              : [400, 413, 422].includes(response.status)
                ? "unsupported-input"
                : "transport",
      };
    }
    let value: unknown;
    try {
      value = await readProviderJsonResponse(response, "Parallel decisions", {
        maxBytes: 1_048_576,
        timeoutMs: Math.max(1, context.deadlineMonotonicMs - performance.now()),
      });
    } catch {
      context.signal.throwIfAborted();
      return { status: "unavailable", reason: "invalid-response" };
    }
    assertActive();
    return decodeParallelDecisionResult(batch, value, context.model.inference?.decision);
  } catch {
    context.signal.throwIfAborted();
    if (admissionError) {
      throw admissionError.error;
    }
    return { status: "unavailable", reason: "transport" };
  } finally {
    await release?.();
  }
}
