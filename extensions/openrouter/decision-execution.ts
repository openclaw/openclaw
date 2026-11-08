import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import {
  readProviderJsonResponse,
  type resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  decodeOpenRouterDecisionResult,
  type encodeOpenRouterDecisionRequest,
} from "./decision-codec.js";
import { resolveOpenRouterSsrfPolicy } from "./provider-catalog.js";

type OpenRouterDecisionTransport = {
  requestConfig: ReturnType<typeof resolveProviderHttpRequestConfig>;
  configuredRequest:
    | Pick<NonNullable<Parameters<typeof resolveOpenRouterSsrfPolicy>[1]>, "allowPrivateNetwork">
    | undefined;
};

type OpenRouterDecisionExecution = Pick<
  DecisionProviderContextV2,
  "signal" | "deadlineMonotonicMs" | "isAdmissible"
> & {
  body: ReturnType<typeof encodeOpenRouterDecisionRequest>;
  capabilities: Parameters<typeof decodeOpenRouterDecisionResult>[2];
  prepareTransport: () => OpenRouterDecisionTransport;
};

export async function executeOpenRouterDecision(
  batch: DecisionBatchV2,
  execution: OpenRouterDecisionExecution,
): Promise<ProviderDecisionOutcomeV2> {
  let release: (() => Promise<void>) | undefined;
  let admissionError: { error: unknown } | undefined;
  const assertActive = () => {
    execution.signal.throwIfAborted();
    let admitted: boolean;
    try {
      admitted = execution.isAdmissible();
    } catch (error) {
      admissionError = { error };
      throw error;
    }
    if (!admitted || performance.now() >= execution.deadlineMonotonicMs) {
      throw new Error("OpenRouter decision is no longer admitted.");
    }
  };
  try {
    const { requestConfig, configuredRequest } = execution.prepareTransport();
    const timeoutMs = execution.deadlineMonotonicMs - performance.now();
    execution.signal.throwIfAborted();
    if (timeoutMs <= 0) {
      return { status: "unavailable", reason: "transport" };
    }
    const guarded = await fetchWithSsrFGuard({
      // Append to the effective API prefix; custom proxies must never escape to the canonical host.
      url: requestConfig.baseUrl + "/systemone",
      init: {
        method: "POST",
        headers: requestConfig.headers,
        body: JSON.stringify(execution.body),
      },
      signal: execution.signal,
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
        timeoutMs: Math.max(1, execution.deadlineMonotonicMs - performance.now()),
      });
    } catch {
      execution.signal.throwIfAborted();
      return { status: "unavailable", reason: "invalid-response" };
    }
    execution.signal.throwIfAborted();
    return decodeOpenRouterDecisionResult(batch, value, execution.capabilities);
  } catch {
    execution.signal.throwIfAborted();
    if (admissionError) {
      throw admissionError.error;
    }
    return { status: "unavailable", reason: "transport" };
  } finally {
    await release?.();
  }
}
