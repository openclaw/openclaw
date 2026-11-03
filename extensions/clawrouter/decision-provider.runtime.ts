import { getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import {
  executeOpenAIDecision,
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
import { normalizeClawRouterRootUrl } from "./base-url.js";
import { grantsLuna } from "./decision-catalog.js";

type ClawRouterDecisionCatalogOutcome =
  | { status: "ready"; root: string }
  | Exclude<ProviderDecisionOutcomeV2, { status: "ok" }>;

type ClawRouterDecisionCatalogExecution = Pick<
  DecisionProviderContextV2,
  "signal" | "deadlineMonotonicMs" | "isAdmissible"
> & {
  baseUrl: DecisionProviderContextV2["model"]["baseUrl"];
  prepareRequest: (root: string) => {
    requestConfig: ReturnType<typeof resolveProviderHttpRequestConfig>;
    reflectsCredential: ReturnType<typeof createProviderCredentialMatcher>;
  };
};

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
  const grant = await prepareClawRouterDecisionCatalog({
    baseUrl: context.model.baseUrl,
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
    prepareRequest: (root) => {
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
      const reflectsCredential = createProviderCredentialMatcher({
        headers: requestConfig.headers,
        request: preparedRequest,
        configuredHeaderNames: Object.keys(context.model.headers ?? {}),
        defaultAuthHeader: "Authorization",
        defaultAuthPrefix: "Bearer ",
      });
      return { requestConfig, reflectsCredential };
    },
  });
  if (grant.status !== "ready") {
    return grant;
  }
  // The shared executor owns inference error classification, including terminal
  // authority exceptions. The catalog catch must not turn those into availability.
  return executeOpenAIDecision(batch, {
    provider: "clawrouter",
    baseUrl: grant.root + "/v1/native/openai/v1",
    modelId: "gpt-6-luna",
    headers: context.model.headers,
    auth: context.auth,
    request: getModelProviderRequestTransport(context.model),
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
    reasoning: context.reasoning,
  });
}

async function prepareClawRouterDecisionCatalog(
  execution: ClawRouterDecisionCatalogExecution,
): Promise<ClawRouterDecisionCatalogOutcome> {
  const timeoutMs = execution.deadlineMonotonicMs - performance.now();
  if (timeoutMs <= 0) {
    return { status: "unavailable", reason: "transport" };
  }
  const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
    signal: execution.signal,
    timeoutMs,
    operation: "ClawRouter decision catalog",
  });
  const signal = timeoutSignal ?? execution.signal;
  let admissionError: { error: unknown } | undefined;
  const assertActive = () => {
    signal.throwIfAborted();
    let admitted: boolean;
    try {
      admitted = execution.isAdmissible();
    } catch (error) {
      admissionError = { error };
      throw error;
    }
    if (!admitted || performance.now() >= execution.deadlineMonotonicMs) {
      throw new Error("ClawRouter decision is no longer admitted.");
    }
  };
  const root = normalizeClawRouterRootUrl(execution.baseUrl);
  try {
    const { requestConfig, reflectsCredential } = execution.prepareRequest(root);
    const endpoint = root + "/v1/catalog";
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
    return { status: "ready", root };
  } catch {
    execution.signal.throwIfAborted();
    if (admissionError) {
      throw admissionError.error;
    }
    return { status: "unavailable", reason: "transport" };
  } finally {
    cleanup();
  }
}
