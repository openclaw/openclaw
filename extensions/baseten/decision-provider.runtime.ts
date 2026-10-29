import { getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionEntry,
  type DecisionProviderContextV2,
  type ProviderDecisionOutcomeV2,
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
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { BASETEN_BASE_URL, BASETEN_DECISION_MODEL_IDS } from "./models.js";

function text(value: DecisionEntry | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

function questions(batch: DecisionBatchV2) {
  return Object.fromEntries(
    Object.entries(batch.questions).map(([id, q]) => {
      const instructions = text(q.instructions);
      if (q.type === "boolean") {
        return [
          id,
          {
            type: "noul",
            instructions: q.criteria
              ? `${instructions}\nTrue criterion: ${text(q.criteria.true)}\nFalse criterion: ${text(q.criteria.false)}`
              : instructions,
          },
        ];
      }
      if (q.type === "choice") {
        return [
          id,
          {
            type: "choice",
            instructions,
            criteria: Object.fromEntries(
              Object.entries(q.criteria).map(([key, value]) => [key, text(value)]),
            ),
          },
        ];
      }
      if (q.type === "score") {
        return [id, { type: "score", instructions, criteria: q.criteria.map(text) }];
      }
      throw new Error("Unsupported Baseten decision question");
    }),
  );
}

function parseResult(
  batch: DecisionBatchV2,
  payload: Record<string, unknown>,
): ProviderDecisionOutcomeV2 {
  const invalid = { status: "unavailable", reason: "invalid-response" } as const;
  if (
    !isRecord(payload.answers) ||
    Object.keys(payload.answers).length !== Object.keys(batch.questions).length ||
    !isRecord(payload.usage)
  ) {
    return invalid;
  }
  const usage = payload.usage;
  if (
    !Number.isSafeInteger(usage.input_tokens) ||
    typeof usage.input_tokens !== "number" ||
    usage.input_tokens < 0 ||
    usage.output_tokens !== Object.keys(batch.questions).length
  ) {
    return invalid;
  }
  const answers: Record<string, unknown> = Object.create(null);
  for (const [id, q] of Object.entries(batch.questions)) {
    const answer = payload.answers[id];
    if (!isRecord(answer)) {
      return invalid;
    }
    if (q.type === "boolean") {
      if (answer.type !== "noul") {
        return invalid;
      }
      answers[id] = { type: "boolean", probabilityTrue: answer.noul };
      continue;
    }
    if (
      answer.type !== q.type ||
      !isRecord(answer.probabilities) ||
      typeof answer.confidence !== "number" ||
      answer.confidence < 0 ||
      answer.confidence > 1
    ) {
      return invalid;
    }
    if (q.type === "choice") {
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
    } else if (q.type === "score") {
      const legend = answer.legend;
      const probabilities = answer.probabilities;
      if (
        !isRecord(legend) ||
        Object.keys(legend).length !== q.criteria.length ||
        Object.keys(probabilities).length !== q.criteria.length ||
        q.criteria.some((value, index) => legend[String(index)] !== text(value))
      ) {
        return invalid;
      }
      answers[id] = {
        type: "score",
        score: answer.score,
        probabilities: q.criteria.map((_, index) => probabilities[String(index)]),
        confidence: answer.confidence,
      };
    } else {
      return invalid;
    }
  }
  // The backend model may differ from the requested public slug. Preserve it.
  const result = {
    model: payload.model,
    answers,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
  };
  return validateDecisionResultV2(batch, result) ? { status: "ok", result } : invalid;
}

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
  const timeoutMs = context.deadlineMonotonicMs - performance.now();
  if (timeoutMs <= 0) {
    return { status: "unavailable", reason: "transport" };
  }
  const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
    signal: context.signal,
    timeoutMs,
    operation: "Baseten decision",
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
      throw new Error("Baseten decision is no longer admitted.");
    }
  };
  try {
    const preparedRequest = getModelProviderRequestTransport(context.model);
    const { baseUrl, headers, dispatcherPolicy, allowPrivateNetwork } =
      resolveProviderHttpRequestConfig({
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
        body: JSON.stringify({
          model: context.model.id,
          state:
            batch.state.type === "text"
              ? batch.state.text
              : batch.state.type === "json"
                ? JSON.stringify(batch.state.value)
                : "",
          questions: questions(batch),
        }),
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
        serialized.includes(auth.apiKey) ||
        createProviderCredentialMatcher({
          headers,
          request: preparedRequest,
          configuredHeaderNames: Object.keys(context.model.headers ?? {}),
          defaultAuthHeader: "Authorization",
          defaultAuthPrefix: "Bearer ",
        })(serialized)
      ) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      return parseResult(batch, payload);
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
