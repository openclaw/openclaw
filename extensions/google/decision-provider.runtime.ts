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
} from "openclaw/plugin-sdk/provider-http";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import {
  decodeGeminiDecisionResult,
  encodeGeminiDecisionRequest,
  supportsGeminiDecisionBatch,
} from "./decision-codec.js";
import { resolveGoogleGenerativeAiHttpRequestConfig } from "./http-request.js";
import { GOOGLE_GEMINI_DECISION_MODEL_IDS } from "./provider-catalog.js";

type GeminiDecisionBatch = Parameters<typeof encodeGeminiDecisionRequest>[0];

type GeminiDecisionExecution = Pick<
  DecisionProviderContextV2,
  "signal" | "deadlineMonotonicMs" | "isAdmissible"
> & {
  modelId: string;
  apiKey: string;
  capabilities: Parameters<typeof decodeGeminiDecisionResult>[3];
  prepareTransport: () => ReturnType<typeof resolveGoogleGenerativeAiHttpRequestConfig> & {
    preparedRequest: ReturnType<typeof getModelProviderRequestTransport>;
    configuredHeaderNames: string[];
  };
};

export async function evaluateGeminiDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (
    context.model.provider !== "google" ||
    !GOOGLE_GEMINI_DECISION_MODEL_IDS.has(context.model.id) ||
    (context.reasoning !== undefined && context.reasoning !== "auto") ||
    !supportsGeminiDecisionBatch(batch)
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const apiKey = context.auth.apiKey;
  if (!apiKey) {
    return { status: "unavailable", reason: "credentials-unavailable" };
  }
  return executeGeminiDecision(batch, {
    modelId: context.model.id,
    apiKey,
    capabilities: context.model.inference?.decision,
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
    prepareTransport: () => {
      const preparedRequest = getModelProviderRequestTransport(context.model);
      // Rejects non-AI Studio hosts: the Decisions API exists only on the Gemini Developer API.
      const requestConfig = resolveGoogleGenerativeAiHttpRequestConfig({
        apiKey,
        baseUrl: context.model.baseUrl,
        headers: context.model.headers,
        request: preparedRequest
          ? {
              proxy: preparedRequest.proxy,
              tls: preparedRequest.tls,
              allowPrivateNetwork: preparedRequest.allowPrivateNetwork,
            }
          : undefined,
        capability: "other",
        transport: "http",
      });
      return {
        ...requestConfig,
        preparedRequest,
        configuredHeaderNames: Object.keys(context.model.headers ?? {}),
      };
    },
  });
}

function unavailableForStatus(response: Response): ProviderDecisionOutcomeV2 {
  const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
  return {
    status: "unavailable",
    reason:
      response.status === 401 || response.status === 403
        ? "authentication"
        : response.status === 429
          ? "rate-limited"
          : // Limit, key-validation and input-safety rejections are all documented as 400.
            [400, 413].includes(response.status)
            ? "unsupported-input"
            : "transport",
    ...(response.status === 429 && seconds !== undefined ? { retryAfterMs: seconds * 1000 } : {}),
  };
}

async function executeGeminiDecision(
  batch: GeminiDecisionBatch,
  execution: GeminiDecisionExecution,
): Promise<ProviderDecisionOutcomeV2> {
  const timeoutMs = execution.deadlineMonotonicMs - performance.now();
  if (timeoutMs <= 0) {
    return { status: "unavailable", reason: "transport" };
  }
  const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
    signal: execution.signal,
    timeoutMs,
    operation: "Gemini decision",
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
      throw new Error("Gemini decision is no longer admitted.");
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
    const url = baseUrl.replace(/\/+$/u, "") + "/decisions";
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
        body: encodeGeminiDecisionRequest(batch, execution.modelId),
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
        return unavailableForStatus(response);
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readProviderJsonObjectResponse(response, "Gemini decision", {
          maxBytes: 4_194_304,
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
          defaultAuthHeader: headers.has("x-goog-api-key") ? "x-goog-api-key" : "Authorization",
          defaultAuthPrefix: headers.has("x-goog-api-key") ? "" : "Bearer ",
        })(serialized)
      ) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      return decodeGeminiDecisionResult(batch, payload, execution.modelId, execution.capabilities);
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
