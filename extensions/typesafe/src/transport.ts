import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  responseWithRelease,
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  createProviderCredentialMatcher,
  resolveProviderHttpRequestConfigWithOriginTrust,
  resolveProviderTransportSsrFPolicy,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  localBaseUrl,
  providerBaseUrl,
  HOSTED_ORIGIN,
  type ModelProviderConfig,
} from "./config.js";
import { EvaluationError } from "./errors.js";
import { MAX_JSON_BYTES, type EvaluationInput } from "./schema.js";

const API_BASE_URL = `${HOSTED_ORIGIN}/v1`;

function httpError(response: Response): EvaluationError {
  if (response.status === 401 || response.status === 403) {
    return new EvaluationError(
      "TypeSafe authentication failed; check the configured credential and account access.",
      "authentication",
    );
  }
  if (response.status === 429) {
    const milliseconds = response.headers.get("retry-after-ms");
    const parsedMilliseconds = milliseconds?.trim() ? Number(milliseconds) : Number.NaN;
    const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
    const retryAfterMs =
      Number.isFinite(parsedMilliseconds) && parsedMilliseconds >= 0
        ? parsedMilliseconds
        : seconds === undefined
          ? undefined
          : seconds * 1000;
    return new EvaluationError(
      "TypeSafe rate limit reached; retry later.",
      "rate-limited",
      retryAfterMs,
    );
  }
  // 400/422 are request validation; 413 is HTTP Content Too Large.
  // Neither establishes the exact tokenizer/context cause, and bodies may reflect secrets.
  if (response.status === 400 || response.status === 413 || response.status === 422) {
    return new EvaluationError("TypeSafe rejected the supplied input.", "unsupported-input");
  }
  return new EvaluationError("TypeSafe service rejected the evaluation request.", "transport");
}

async function readBody(response: Response, signal?: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    signal?.throwIfAborted();
    return Buffer.alloc(0);
  }
  // Keep the request owned until cancellation settles, even when a stream ignores its signal.
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) {
        break;
      }
      length += chunk.value.byteLength;
      if (length > MAX_JSON_BYTES) {
        throw new EvaluationError("TypeSafe response exceeds its limit.", "invalid-response");
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await cancellation;
    reader.releaseLock();
  }
}

export async function requestEvaluation(params: {
  body: EvaluationInput & { model: string };
  apiKey?: string;
  baseUrl?: string;
  providerConfig?: ModelProviderConfig;
  timeoutMs: number;
  signal?: AbortSignal;
  deadlineMonotonicMs?: number;
  isAdmissible?: () => boolean;
}): Promise<unknown> {
  const baseUrl = params.providerConfig
    ? providerBaseUrl(params.providerConfig.baseUrl)
    : localBaseUrl(params.baseUrl);
  const apiBaseUrl = params.providerConfig ? baseUrl : baseUrl ? `${baseUrl}/v1` : API_BASE_URL;
  let resolved: ReturnType<typeof resolveProviderHttpRequestConfigWithOriginTrust>;
  let configuredRequest: ReturnType<typeof sanitizeConfiguredModelProviderRequest>;
  try {
    configuredRequest = sanitizeConfiguredModelProviderRequest(params.providerConfig?.request);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(params.providerConfig?.headers ?? {})) {
      const headerValue = normalizeResolvedSecretInputString({
        value,
        path: `models.providers.typesafe.headers.${name}`,
      });
      if (headerValue !== undefined) {
        headers[name] = headerValue;
      }
    }
    // Legacy loopback config never uses the hosted plugin key. Standard model
    // provider config supplies only its own prepared credential and request policy.
    const credential = !baseUrl || params.providerConfig ? params.apiKey : undefined;
    resolved = resolveProviderHttpRequestConfigWithOriginTrust({
      provider: "typesafe",
      capability: "other",
      transport: "http",
      baseUrl: apiBaseUrl,
      defaultBaseUrl: API_BASE_URL,
      defaultHeaders: {
        ...(credential && params.providerConfig?.authHeader !== false
          ? { Authorization: `Bearer ${credential}` }
          : {}),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...headers,
      },
      request: configuredRequest,
    });
  } catch {
    throw new EvaluationError(
      "TypeSafe provider credentials or request settings are unavailable.",
      "credentials-unavailable",
    );
  }
  const reflectsCredential = createProviderCredentialMatcher({
    headers: resolved.headers,
    request: configuredRequest,
    configuredHeaderNames: Object.keys(params.providerConfig?.headers ?? {}),
    defaultAuthHeader: "Authorization",
    defaultAuthPrefix: "Bearer ",
  });
  const endpoint = `${resolved.baseUrl}/systemone`;
  const policy = baseUrl
    ? resolveProviderTransportSsrFPolicy({
        baseUrl: resolved.baseUrl,
        url: endpoint,
        allowPrivateNetwork: resolved.allowPrivateNetwork,
        trustConfiguredBaseUrlOrigin: resolved.trustConfiguredBaseUrlOrigin,
      })
    : undefined;
  const body = JSON.stringify(params.body);
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
    throw new EvaluationError("TypeSafe request exceeds its limit.", "unsupported-input");
  }
  const timeoutMs =
    params.deadlineMonotonicMs === undefined
      ? params.timeoutMs
      : Math.min(params.timeoutMs, params.deadlineMonotonicMs - performance.now());
  if (timeoutMs <= 0) {
    throw new EvaluationError("TypeSafe evaluation timed out.", "transport");
  }
  const { signal, cleanup } = buildTimeoutAbortSignal({
    signal: params.signal,
    timeoutMs,
    operation: "TypeSafe evaluation",
  });
  const assertActive = () => {
    signal?.throwIfAborted();
    // Synchronous preparation can exhaust the deadline before its abort timer runs.
    if (
      params.deadlineMonotonicMs !== undefined &&
      performance.now() >= params.deadlineMonotonicMs
    ) {
      throw new EvaluationError("TypeSafe evaluation timed out.", "transport");
    }
    if (params.isAdmissible && !params.isAdmissible()) {
      throw new EvaluationError("TypeSafe evaluation is no longer admitted.", "transport");
    }
  };
  try {
    assertActive();
    const request = {
      url: endpoint,
      fetchImpl: globalThis.fetch,
      requireHttps: !baseUrl || new URL(baseUrl).protocol === "https:",
      policy,
      dispatcherPolicy: resolved.dispatcherPolicy,
      ...(baseUrl && new URL(baseUrl).hostname === "localhost"
        ? {
            // Keep localhost local even when system DNS or hosts entries override its meaning.
            lookupFn: async () => [
              { address: "127.0.0.1", family: 4 },
              { address: "::1", family: 6 },
            ],
          }
        : {}),
      maxRedirects: 0,
      signal,
      beforeRequest: assertActive,
      init: {
        method: "POST",
        headers: resolved.headers,
        body,
      },
    };
    const guarded = await fetchWithSsrFGuard(
      !baseUrl && !resolved.dispatcherPolicy && shouldUseEnvHttpProxyForUrl(endpoint)
        ? withTrustedEnvProxyGuardedFetchMode(request)
        : request,
    );
    let releasePromise: Promise<void> | undefined;
    const release = () => (releasePromise ??= Promise.resolve().then(() => guarded.release()));
    let payload: unknown;
    try {
      const response = responseWithRelease(guarded.response, release);
      if (!response.ok) {
        // Error payloads may reflect credentials or supplied state. Never consume or expose them.
        await response.body?.cancel();
        throw httpError(response);
      }
      const bytes = await readBody(response, signal);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        payload = JSON.parse(text);
      } catch {
        throw new EvaluationError("TypeSafe returned invalid JSON.", "invalid-response");
      }
      // JSON escapes can conceal a credential in raw text; check its decoded
      // representation too. Custom header prefixes may be absent in reflections.
      const decodedText = JSON.stringify(payload);
      if (reflectsCredential(text) || (decodedText !== text && reflectsCredential(decodedText))) {
        throw new EvaluationError(
          "TypeSafe evaluation failed or returned an invalid response.",
          "invalid-response",
        );
      }
    } finally {
      await release();
    }
    signal?.throwIfAborted();
    return payload;
  } catch (error) {
    if (params.signal?.aborted) {
      throw new EvaluationError("TypeSafe evaluation cancelled.", "transport");
    }
    if (signal?.aborted) {
      throw new EvaluationError("TypeSafe evaluation timed out.", "transport");
    }
    if (error instanceof EvaluationError) {
      throw error;
    }
    throw new EvaluationError("TypeSafe transport unavailable.", "transport");
  } finally {
    cleanup();
  }
}
