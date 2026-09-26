import {
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionProviderV2,
  type DecisionProviderContextV2,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import {
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  OPENROUTER_BASE_URL,
  resolveOpenRouterApiBaseUrl,
  resolveOpenRouterSsrfPolicy,
} from "./provider-catalog.js";
import {
  resolveOpenRouterExtraParamsForTransport,
  resolveOpenRouterConfiguredExtraParams,
} from "./provider-routing.js";

export function isOpenRouterDecisionModel(modelId: string): boolean {
  return modelId === "typesafe/jev-1.13" || modelId === "~typesafe/jev-latest";
}

function unsupported(): ProviderDecisionOutcomeV2 {
  return { status: "unavailable", reason: "unsupported-input" };
}

function supportsBatch(batch: DecisionBatchV2): boolean {
  if (!validateDecisionBatchV2(batch)) {
    return false;
  }
  // System One accepts strings, objects and arrays, not images or primitive JSON scalars.
  if (
    batch.state.type !== "text" &&
    (batch.state.type !== "json" ||
      batch.state.value === null ||
      (typeof batch.state.value !== "object" && typeof batch.state.value !== "string"))
  ) {
    return false;
  }
  return Object.values(batch.questions).every((q) => {
    if (q.type === "sort" || q.type === "tags" || q.instructions == null) {
      return false;
    }
    if (q.type === "choice") {
      return Object.keys(q.criteria).length <= 255;
    }
    if (q.type === "score") {
      return q.criteria.length <= 10 && q.criteria.every((entry) => entry !== null);
    }
    return (
      q.criteria === undefined ||
      (q.criteria !== null && q.criteria.true != null && q.criteria.false != null)
    );
  });
}

function decodeResponse(batch: DecisionBatchV2, response: unknown): unknown {
  const root = asOptionalRecord(response);
  const answers = asOptionalRecord(root?.answers);
  const usage = asOptionalRecord(root?.usage);
  if (
    !root ||
    !answers ||
    !usage ||
    !Number.isSafeInteger(usage.input_tokens) ||
    !Number.isSafeInteger(usage.output_tokens) ||
    (root.provider !== undefined && typeof root.provider !== "string")
  ) {
    return undefined;
  }
  const converted = Object.fromEntries(
    Object.entries(answers).map(([id, value]) => {
      const answer = asOptionalRecord(value);
      const question = batch.questions[id];
      if (!answer) {
        return [id, undefined];
      }
      if (answer.type === "noul") {
        return [id, { type: "boolean", probabilityTrue: answer.noul }];
      }
      if (answer.type !== "choice" && answer.type !== "score") {
        return [id, undefined];
      }
      if (
        typeof answer.confidence !== "number" ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1
      ) {
        return [id, undefined];
      }
      if (answer.type === "choice") {
        return [
          id,
          {
            type: "choice",
            choice: answer.choice,
            probabilities: answer.probabilities,
            confidence: answer.confidence,
          },
        ];
      }
      const probabilities = asOptionalRecord(answer.probabilities);
      if (
        question?.type !== "score" ||
        !probabilities ||
        Object.keys(probabilities).length !== question.criteria.length ||
        !question.criteria.every((_, index) => Object.hasOwn(probabilities, String(index)))
      ) {
        return [id, undefined];
      }
      // Keep the native score and rounded estimates; never recompute either from the other.
      return [
        id,
        {
          type: "score",
          score: answer.score,
          probabilities: question.criteria.map((_, index) => probabilities[String(index)]),
          confidence: answer.confidence,
        },
      ];
    }),
  );
  return {
    model: root.model,
    answers: converted,
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(usage.cost !== undefined ? { costUsd: usage.cost } : {}),
      ...(Object.keys(usage).some((key) => !["input_tokens", "output_tokens", "cost"].includes(key))
        ? { raw: usage }
        : {}),
    },
    ...(root.provider !== undefined ? { metadata: { provider: root.provider } } : {}),
  };
}

function buildRequest(batch: DecisionBatchV2, context: DecisionProviderContextV2) {
  const extraParams =
    resolveOpenRouterConfiguredExtraParams({
      config: context.config,
      agentId: context.agentId,
      modelId: context.model.id,
    }) ?? {};
  const routed =
    resolveOpenRouterExtraParamsForTransport({
      config: context.config,
      provider: "openrouter",
      model: context.model,
      extraParams,
    })?.patch ?? extraParams;
  // This route only documents provider preferences. Do not silently drop configured
  // parameter limits, privacy settings or unsupported chat controls.
  if (routed && Object.keys(routed).some((key) => key !== "provider")) {
    return undefined;
  }
  return {
    model: context.model.id,
    state:
      batch.state.type === "text"
        ? batch.state.text
        : batch.state.type === "json"
          ? batch.state.value
          : undefined,
    questions: Object.fromEntries(
      Object.entries(batch.questions).map(([id, question]) => [
        id,
        { ...question, type: question.type === "boolean" ? "noul" : question.type },
      ]),
    ),
    ...(routed?.provider !== undefined ? { provider: routed.provider } : {}),
  };
}

export function buildOpenRouterDecisionProvider(): DecisionProviderV2 {
  return {
    id: "openrouter",
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      if (
        !isOpenRouterDecisionModel(context.model.id) ||
        (context.reasoning !== undefined && context.reasoning !== "auto") ||
        !supportsBatch(batch)
      ) {
        return unsupported();
      }
      const body = buildRequest(batch, context);
      if (!body) {
        return unsupported();
      }
      if (!context.auth.apiKey && !context.model.headers) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const providerConfig = context.config.models?.providers?.openrouter;
      let release: (() => Promise<void>) | undefined;
      try {
        // Auth and effective headers are prepared by the host. Only proxy/TLS/SSRF
        // policy is read here; never select a second credential or auth profile.
        const configuredRequest = providerConfig?.request;
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
          provider: "openrouter",
          capability: "llm",
          transport: "http",
          baseUrl: resolveOpenRouterApiBaseUrl(context.model.baseUrl ?? providerConfig?.baseUrl),
          defaultBaseUrl: OPENROUTER_BASE_URL,
          defaultHeaders: {
            "Content-Type": "application/json",
            // The host already applied an explicit auth override to its private headers.
            // Do not restore the provider-default bearer after a custom header replaced it.
            ...(context.auth.apiKey &&
            (!configuredRequest?.auth || configuredRequest.auth.mode === "provider-default")
              ? { Authorization: `Bearer ${context.auth.apiKey}` }
              : {}),
          },
          headers: context.model.headers,
          request,
        });
        const timeoutMs = context.deadlineMonotonicMs - performance.now();
        context.signal.throwIfAborted();
        if (timeoutMs <= 0) {
          return { status: "unavailable", reason: "transport" };
        }
        const guarded = await fetchWithSsrFGuard({
          // Append to the effective API prefix; custom proxies must never escape to the canonical host.
          url: requestConfig.baseUrl + "/systemone",
          init: { method: "POST", headers: requestConfig.headers, body: JSON.stringify(body) },
          signal: context.signal,
          timeoutMs,
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
            timeoutMs: Math.max(1, context.deadlineMonotonicMs - performance.now()),
          });
        } catch {
          context.signal.throwIfAborted();
          return { status: "unavailable", reason: "invalid-response" };
        }
        context.signal.throwIfAborted();
        const result = decodeResponse(batch, value);
        return validateDecisionResultV2(batch, result, context.model.inference?.decision)
          ? { status: "ok", result }
          : { status: "unavailable", reason: "invalid-response" };
      } catch {
        context.signal.throwIfAborted();
        return { status: "unavailable", reason: "transport" };
      } finally {
        await release?.();
      }
    },
  };
}
