import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  responseWithRelease,
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  createProviderCredentialMatcher,
  fetchWithProviderHttpGuard,
  resolveProviderHttpRequestConfigWithOriginTrust,
  resolveProviderTransportSsrFPolicy,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  hasCredentials,
  usesHostedEndpoint,
  localBaseUrl,
  providerBaseUrl,
  HOSTED_ORIGIN,
  type RuntimeConfig,
} from "./config.js";
import { EvaluationError, evaluationError } from "./errors.js";
import { MAX_JSON_BYTES, parseInput, parseResult } from "./schema.js";

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

/** Evaluate explicit state without ambient credentials, retries, or vendor diagnostics. */
export async function evaluate(
  input: unknown,
  config: RuntimeConfig,
  abortSignal?: AbortSignal,
  deadlineMonotonicMs?: number,
  isAdmissible?: () => boolean,
) {
  if (abortSignal?.aborted) {
    throw evaluationError(undefined, true);
  }
  const parsed = parseInput(input);
  const model = parsed.model;
  if (!model) {
    throw new EvaluationError("TypeSafe requires a host-selected model.", "unsupported-input");
  }
  const hosted = usesHostedEndpoint(config);
  if (model === "kev-latest" && hosted) {
    throw new EvaluationError(
      "Kev requires a local System One server. Configure baseUrl in TypeSafe plugin Settings.",
      "unsupported-input",
    );
  }
  if (!hasCredentials(config)) {
    throw new Error("TypeSafe API key is missing. Configure a SecretRef in plugin Settings.");
  }
  try {
    let wireInput = parsed;
    if (!hosted) {
      const questions: typeof parsed.questions = {};
      for (const [id, question] of Object.entries(parsed.questions)) {
        const instructions = question.instructions ?? null;
        if (question.type === "score") {
          questions[id] = {
            ...question,
            instructions,
            // Send explicit text so the returned legend can be verified without reproducing Kev's renderer.
            criteria: question.criteria.map((level) =>
              typeof level === "string" ? level : level === null ? "" : JSON.stringify(level),
            ),
          };
        } else {
          questions[id] = { ...question, instructions };
        }
      }
      wireInput = { ...parsed, questions };
    }
    const baseUrl = config.providerConfig
      ? providerBaseUrl(config.providerConfig.baseUrl)
      : localBaseUrl(config.baseUrl);
    const apiBaseUrl = config.providerConfig ? baseUrl : baseUrl ? `${baseUrl}/v1` : API_BASE_URL;
    let resolved: ReturnType<typeof resolveProviderHttpRequestConfigWithOriginTrust>;
    let configuredRequest: ReturnType<typeof sanitizeConfiguredModelProviderRequest>;
    try {
      configuredRequest = sanitizeConfiguredModelProviderRequest(config.providerConfig?.request);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(config.providerConfig?.headers ?? {})) {
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
      const credential = !baseUrl || config.providerConfig ? config.apiKey : undefined;
      resolved = resolveProviderHttpRequestConfigWithOriginTrust({
        provider: "typesafe",
        capability: "other",
        transport: "http",
        baseUrl: apiBaseUrl,
        defaultBaseUrl: API_BASE_URL,
        defaultHeaders: {
          ...(credential && config.providerConfig?.authHeader !== false
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
      configuredHeaderNames: Object.keys(config.providerConfig?.headers ?? {}),
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
    const body = JSON.stringify({ ...wireInput, model });
    if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
      throw new EvaluationError("TypeSafe request exceeds its limit.", "unsupported-input");
    }
    const timeoutMs =
      deadlineMonotonicMs === undefined
        ? config.timeoutMs
        : Math.min(config.timeoutMs, deadlineMonotonicMs - performance.now());
    if (timeoutMs <= 0) {
      throw new EvaluationError("TypeSafe evaluation timed out.", "transport");
    }
    const { signal, cleanup } = buildTimeoutAbortSignal({
      signal: abortSignal,
      timeoutMs,
      operation: "TypeSafe evaluation",
    });
    const assertActive = () => {
      signal?.throwIfAborted();
      // Synchronous preparation can exhaust the deadline before its abort timer runs.
      if (deadlineMonotonicMs !== undefined && performance.now() >= deadlineMonotonicMs) {
        throw new EvaluationError("TypeSafe evaluation timed out.", "transport");
      }
      if (isAdmissible && !isAdmissible()) {
        throw new EvaluationError("TypeSafe evaluation is no longer admitted.", "transport");
      }
    };
    let responsePayload: unknown;
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
      const guarded = await fetchWithProviderHttpGuard(
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
        const bytes = await readResponseWithLimit(response, MAX_JSON_BYTES, {
          signal,
          onOverflow: () =>
            new EvaluationError("TypeSafe response exceeds its limit.", "invalid-response"),
        });
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
      responsePayload = payload;
    } catch (error) {
      if (abortSignal?.aborted) {
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
    abortSignal?.throwIfAborted();
    if (!hosted) {
      if (
        !responsePayload ||
        typeof responsePayload !== "object" ||
        Array.isArray(responsePayload)
      ) {
        throw new Error("Invalid local System One response.");
      }
      if ("latency_ms" in responsePayload) {
        const { latency_ms, ...payload } = responsePayload;
        if (typeof latency_ms !== "number" || !Number.isFinite(latency_ms) || latency_ms < 0) {
          throw new Error("Invalid local System One latency metadata.");
        }
        responsePayload = payload;
      }
    }
    const evaluation = parseResult(responsePayload, wireInput);
    if (!hosted) {
      for (const [id, question] of Object.entries(parsed.questions)) {
        const answer = evaluation.answers[id];
        if (question.type === "score" && answer?.type === "score") {
          answer.legend = Object.fromEntries(
            question.criteria.map((level, index) => [String(index), level]),
          );
        }
      }
    }
    return { evaluation };
  } catch (error) {
    throw evaluationError(error, abortSignal?.aborted ?? false);
  }
}
