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

export async function evaluateGeminiDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  const capabilities = context.model.inference?.decision;
  if (
    context.model.provider !== "google" ||
    capabilities?.protocol !== "gemini-decisions" ||
    (context.reasoning !== undefined && context.reasoning !== "auto") ||
    !supportsGeminiDecisionBatch(batch)
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const apiKey = context.auth.apiKey;
  if (!apiKey) {
    return { status: "unavailable", reason: "credentials-unavailable" };
  }
  const timeoutMs = context.deadlineMonotonicMs - performance.now();
  if (timeoutMs <= 0) {
    return { status: "unavailable", reason: "transport" };
  }
  const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
    signal: context.signal,
    timeoutMs,
    operation: "Gemini decision",
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
      throw new Error("Gemini decision is no longer admitted.");
    }
  };
  try {
    const preparedRequest = getModelProviderRequestTransport(context.model);
    // Rejects non-AI Studio hosts: the Decisions API exists only on the Gemini Developer API.
    const { baseUrl, headers, dispatcherPolicy, allowPrivateNetwork } =
      resolveGoogleGenerativeAiHttpRequestConfig({
        apiKey,
        baseUrl: context.model.baseUrl,
        headers: context.model.headers,
        request: preparedRequest && {
          proxy: preparedRequest.proxy,
          tls: preparedRequest.tls,
          allowPrivateNetwork: preparedRequest.allowPrivateNetwork,
        },
        capability: "other",
        transport: "http",
      });
    const url = baseUrl.replace(/\/+$/u, "") + "/decisions";
    const request = {
      url,
      signal,
      beforeRequest: assertActive,
      maxRedirects: 0,
      dispatcherPolicy,
      policy: { allowPrivateNetwork },
      init: { method: "POST", headers, body: encodeGeminiDecisionRequest(batch, context.model.id) },
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
      const apiKeyHeader = headers.has("x-goog-api-key");
      if (
        serialized.includes(apiKey) ||
        createProviderCredentialMatcher({
          headers,
          request: preparedRequest,
          configuredHeaderNames: Object.keys(context.model.headers ?? {}),
          defaultAuthHeader: apiKeyHeader ? "x-goog-api-key" : "Authorization",
          defaultAuthPrefix: apiKeyHeader ? "" : "Bearer ",
        })(serialized)
      ) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      return decodeGeminiDecisionResult(batch, payload, context.model.id, capabilities);
    } finally {
      await release();
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
}
