import { getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import {
  evaluateOpenAICompatibleDecision,
  supportsOpenAIDecisionBatch,
} from "openclaw/plugin-sdk/decisions-openai-runtime";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  createProviderCredentialMatcher,
  fetchWithProviderHttpGuard,
  resolveProviderHttpRequestConfig,
  readProviderJsonObjectResponse,
} from "openclaw/plugin-sdk/provider-http";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterRootUrl } from "./provider-catalog.js";

// Only this reviewed native protocol is implemented. Catalog strings cannot select
// an arbitrary destination, model alias, or another upstream credential owner.
function grantsLuna(rows: readonly unknown[]): boolean {
  return rows.some(
    (provider) =>
      isRecord(provider) &&
      provider.id === "openai" &&
      provider.nativeBaseUrl === "/v1/native/openai" &&
      Array.isArray(provider.routes) &&
      provider.routes.some(
        (route: unknown) =>
          isRecord(route) &&
          route.path === "/v1/decisions" &&
          route.requestFormat === "openai.decisions" &&
          Array.isArray(route.methods) &&
          route.methods.includes("POST"),
      ) &&
      Array.isArray(provider.models) &&
      provider.models.some(
        (model: unknown) =>
          isRecord(model) &&
          model.id === "openai/gpt-6-luna" &&
          model.upstream === "gpt-6-luna" &&
          Array.isArray(model.capabilities) &&
          model.capabilities.includes("llm.decisions"),
      ),
  );
}

export async function evaluateClawRouterDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (
    context.model.provider !== "clawrouter" ||
    context.model.id !== "openai/gpt-6-luna" ||
    context.model.api !== "openai-responses" ||
    !supportsOpenAIDecisionBatch(batch, context.reasoning)
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  if (context.auth.mode !== "api-key" || !context.auth.apiKey) {
    return { status: "unavailable", reason: "credentials-unavailable" };
  }
  const timeoutMs = context.deadlineMonotonicMs - performance.now();
  if (timeoutMs <= 0) {
    return { status: "unavailable", reason: "transport" };
  }
  const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
    signal: context.signal,
    timeoutMs,
    operation: "ClawRouter decision catalog",
  });
  const signal = timeoutSignal ?? context.signal;
  let admissionError: { error: unknown } | undefined;
  const assertActive = () => {
    signal.throwIfAborted();
    let admitted: boolean;
    try {
      admitted = context.isAdmissible();
    } catch (error) {
      admissionError = { error };
      throw error;
    }
    if (!admitted || performance.now() >= context.deadlineMonotonicMs) {
      throw new Error("ClawRouter decision is no longer admitted.");
    }
  };
  const root = normalizeClawRouterRootUrl(context.model.baseUrl);
  try {
    const preparedRequest = getModelProviderRequestTransport(context.model);
    const requestConfig = resolveProviderHttpRequestConfig({
      provider: "clawrouter",
      capability: "other",
      transport: "http",
      baseUrl: root,
      defaultBaseUrl: root,
      headers: context.model.headers,
      defaultHeaders: {
        Accept: "application/json",
        ...(!preparedRequest?.auth || preparedRequest.auth.mode === "provider-default"
          ? { Authorization: `Bearer ${context.auth.apiKey}` }
          : {}),
      },
      request: preparedRequest
        ? {
            proxy: preparedRequest.proxy,
            tls: preparedRequest.tls,
            allowPrivateNetwork: preparedRequest.allowPrivateNetwork,
          }
        : undefined,
    });
    const endpoint = root + "/v1/catalog";
    const reflectsCredential = createProviderCredentialMatcher({
      headers: requestConfig.headers,
      request: preparedRequest,
      configuredHeaderNames: Object.keys(context.model.headers ?? {}),
      defaultAuthHeader: "Authorization",
      defaultAuthPrefix: "Bearer ",
    });
    // Eligibility is checked with this call's effective key and transport. Do not
    // share grants or in-flight requests across agent authorities or endpoints.
    const request = {
      url: endpoint,
      signal,
      beforeRequest: assertActive,
      maxRedirects: 0,
      dispatcherPolicy: requestConfig.dispatcherPolicy,
      policy: { allowPrivateNetwork: requestConfig.allowPrivateNetwork },
      init: { headers: requestConfig.headers },
    };
    const { response, release } = await fetchWithProviderHttpGuard(
      !requestConfig.dispatcherPolicy && shouldUseEnvHttpProxyForUrl(endpoint)
        ? withTrustedEnvProxyGuardedFetchMode(request)
        : request,
    );
    let rows: readonly unknown[];
    try {
      if (!response.ok) {
        await response.body?.cancel();
        const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
        return {
          status: "unavailable",
          reason:
            response.status === 401 || response.status === 403
              ? "authentication"
              : response.status === 429
                ? "rate-limited"
                : "transport",
          ...(response.status === 429 && seconds !== undefined
            ? { retryAfterMs: seconds * 1000 }
            : {}),
        };
      }
      try {
        const body = await readProviderJsonObjectResponse(response, "ClawRouter decision catalog", {
          maxBytes: 4_194_304,
          signal,
          requestHeaders: requestConfig.headers,
        });
        if (!Array.isArray(body.providers) || reflectsCredential(JSON.stringify(body))) {
          return { status: "unavailable", reason: "invalid-response" };
        }
        rows = body.providers;
      } catch {
        signal.throwIfAborted();
        return { status: "unavailable", reason: "invalid-response" };
      }
    } finally {
      await release();
    }
    assertActive();
    if (!grantsLuna(rows)) {
      return { status: "unavailable", reason: "unsupported-input" };
    }
  } catch {
    context.signal.throwIfAborted();
    if (admissionError) {
      throw admissionError.error;
    }
    return { status: "unavailable", reason: "transport" };
  } finally {
    cleanup();
  }
  // The shared executor owns inference error classification, including terminal
  // authority exceptions. The catalog catch must not turn those into availability.
  return evaluateOpenAICompatibleDecision(batch, context, {
    provider: "clawrouter",
    baseUrl: root + "/v1/native/openai/v1",
    modelId: "gpt-6-luna",
  });
}
