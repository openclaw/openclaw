import { getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  createProviderCredentialMatcher,
  fetchWithProviderHttpGuard,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { decodeBasetenDecisionResult, encodeBasetenDecisionRequest } from "./decision-codec.js";
import { BASETEN_BASE_URL, BASETEN_DECISION_MODEL_IDS } from "./models.js";

type BasetenDecisionExecution = Pick<
  DecisionProviderContextV2,
  "signal" | "deadlineMonotonicMs" | "isAdmissible"
> & {
  modelId: string;
  apiKey: string;
  prepareTransport: () => ReturnType<typeof resolveProviderHttpRequestConfig> & {
    preparedRequest: ReturnType<typeof getModelProviderRequestTransport>;
    configuredHeaderNames: string[];
  };
};

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
  return executeBasetenDecision(batch, {
    modelId: context.model.id,
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
        preparedRequest,
        configuredHeaderNames: Object.keys(context.model.headers ?? {}),
      };
    },
  });
}

async function executeBasetenDecision(
  batch: DecisionBatchV2,
  execution: BasetenDecisionExecution,
): Promise<ProviderDecisionOutcomeV2> {
  const timeoutMs = execution.deadlineMonotonicMs - performance.now();
  if (timeoutMs <= 0) {
    return { status: "unavailable", reason: "transport" };
  }
  const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
    signal: execution.signal,
    timeoutMs,
    operation: "Baseten decision",
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
      throw new Error("Baseten decision is no longer admitted.");
    }
  };
  try {
    const {
      baseUrl,
      headers,
      dispatcherPolicy,
      allowPrivateNetwork,
      preparedRequest,
      configuredHeaderNames,
    } = execution.prepareTransport();
    const url = baseUrl.replace(/\/$/, "") + "/systemone";
    const request = {
      url,
      signal,
      beforeRequest: assertActive,
      maxRedirects: 0,
      dispatcherPolicy,
      policy: { allowPrivateNetwork },
      init: {
        method: "POST",
        headers,
        body: encodeBasetenDecisionRequest(batch, execution.modelId),
      },
    };
    const { response, release } = await fetchWithProviderHttpGuard(
      !dispatcherPolicy && shouldUseEnvHttpProxyForUrl(url)
        ? withTrustedEnvProxyGuardedFetchMode(request)
        : request,
    );
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
                : [400, 413, 422].includes(response.status)
                  ? "unsupported-input"
                  : "transport",
          ...(response.status === 429 && seconds !== undefined
            ? { retryAfterMs: seconds * 1000 }
            : {}),
        };
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readProviderJsonObjectResponse(response, "Baseten decision", {
          maxBytes: 1_048_576,
          signal,
          requestHeaders: headers,
        });
      } catch {
        signal.throwIfAborted();
        return { status: "unavailable", reason: "invalid-response" };
      }
      assertActive();
      const serialized = JSON.stringify(payload);
      if (
        serialized.includes(execution.apiKey) ||
        createProviderCredentialMatcher({
          headers,
          request: preparedRequest,
          configuredHeaderNames,
          defaultAuthHeader: "Authorization",
          defaultAuthPrefix: "Bearer ",
        })(serialized)
      ) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      return decodeBasetenDecisionResult(batch, payload);
    } finally {
      await release();
    }
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
