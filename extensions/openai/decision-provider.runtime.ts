import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  DecisionAnswer,
  DecisionBatch,
  DecisionEntry,
  DecisionProviderV1,
  ProviderDecisionOutcome,
} from "openclaw/plugin-sdk/decisions";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import { findNormalizedProviderValue } from "openclaw/plugin-sdk/provider-auth";
import {
  isProviderAuthError,
  resolveApiKeyForProvider,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  classifyOpenAIBaseUrl,
  OPENAI_API_BASE_URL,
  resolveOpenAIDefaultBaseUrl,
} from "./base-url.js";

type Context = Parameters<DecisionProviderV1["evaluate"]>[1];

function text(value: DecisionEntry | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

function questions(batch: DecisionBatch) {
  return Object.entries(batch.questions).map(([name, question]) => {
    const instructions = text(question.instructions);
    if (question.type === "boolean") {
      return {
        type: "predicate",
        name,
        instructions: question.criteria
          ? `${instructions}\nTrue criterion: ${text(question.criteria.true)}\nFalse criterion: ${text(question.criteria.false)}`
          : instructions,
      };
    }
    if (question.type === "choice") {
      return {
        type: "choice",
        name,
        instructions,
        choices: Object.entries(question.criteria).map(([value, description]) => ({
          value,
          description: text(description),
        })),
      };
    }
    return {
      type: "score",
      name,
      instructions,
      levels: question.criteria.map((description, index) => ({
        label: String(index),
        description: text(description),
      })),
    };
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseResult(
  batch: DecisionBatch,
  payload: Record<string, unknown>,
): ProviderDecisionOutcome {
  const entries = Object.entries(batch.questions);
  if (
    typeof payload.model !== "string" ||
    !payload.model ||
    payload.model.length > 256 ||
    !Array.isArray(payload.answers) ||
    payload.answers.length !== entries.length
  ) {
    return { status: "unavailable", reason: "invalid-response" };
  }
  const answers: [string, DecisionAnswer][] = [];
  for (const [index, [name, question]] of entries.entries()) {
    const answer: unknown = payload.answers[index];
    if (!record(answer) || answer.name !== name) {
      return { status: "unavailable", reason: "invalid-response" };
    }
    // V1 cannot carry per-question refusals. Never invent a probability or publish a partial batch.
    if (answer.type === "refusal") {
      return { status: "unavailable", reason: "unsupported-input" };
    }
    if (question.type === "boolean") {
      if (answer.type !== "predicate" || !probability(answer.probability)) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      answers.push([name, { type: "boolean", probabilityTrue: answer.probability }]);
      continue;
    }
    if (
      answer.type !== question.type ||
      !Array.isArray(answer.probabilities) ||
      typeof answer.confidence !== "number" ||
      !Number.isFinite(answer.confidence)
    ) {
      return { status: "unavailable", reason: "invalid-response" };
    }
    const labels =
      question.type === "choice"
        ? Object.keys(question.criteria)
        : question.criteria.map((_, i) => String(i));
    const distribution = new Map<string, number>();
    for (const item of answer.probabilities) {
      const label = record(item) ? item[question.type === "choice" ? "value" : "label"] : undefined;
      if (
        !record(item) ||
        typeof label !== "string" ||
        !labels.includes(label) ||
        distribution.has(label) ||
        !probability(item.probability) ||
        (question.type === "score" && item.value !== Number(label))
      ) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      distribution.set(label, item.probability);
    }
    if (
      distribution.size !== labels.length ||
      ![...distribution.values()].some((value) => value > 0)
    ) {
      return { status: "unavailable", reason: "invalid-response" };
    }
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !distribution.has(answer.choice)) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      answers.push([
        name,
        {
          type: "choice",
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: Object.fromEntries(distribution),
        },
      ]);
    } else {
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > labels.length - 1
      ) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      answers.push([
        name,
        {
          type: "score",
          score: answer.score,
          confidence: answer.confidence,
          probabilities: labels.map((label) => distribution.get(label)!),
        },
      ]);
    }
  }
  const usage = payload.usage;
  if (
    !record(usage) ||
    typeof usage.input_tokens !== "number" ||
    !Number.isInteger(usage.input_tokens) ||
    usage.input_tokens < 0 ||
    typeof usage.output_tokens !== "number" ||
    !Number.isInteger(usage.output_tokens) ||
    usage.output_tokens < 0
  ) {
    return { status: "unavailable", reason: "invalid-response" };
  }
  return {
    status: "ok",
    result: {
      model: payload.model,
      answers: Object.fromEntries(answers),
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      },
    },
  };
}

export async function evaluateOpenAIDecision(
  batch: DecisionBatch,
  context: Context,
  config: OpenClawConfig,
): Promise<ProviderDecisionOutcome> {
  context.signal.throwIfAborted();
  const providerConfig = findNormalizedProviderValue(config.models?.providers, "openai");
  const configuredBaseUrl = providerConfig?.baseUrl ?? resolveOpenAIDefaultBaseUrl();
  const endpointKind = classifyOpenAIBaseUrl(configuredBaseUrl);
  if (endpointKind === "chatgpt" || endpointKind === "invalid") {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  let auth: Awaited<ReturnType<typeof resolveApiKeyForProvider>>;
  try {
    auth = await resolveApiKeyForProvider({
      provider: "openai",
      cfg: config,
      modelId: context.model,
      modelApi: "openai-responses",
      modelBaseUrl: configuredBaseUrl,
      capability: "decision",
      ...(context.agentId ? { agentDir: resolveAgentDir(config, context.agentId) } : {}),
      signal: context.signal,
    });
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      status: "unavailable",
      reason:
        isProviderAuthError(error, "missing-provider-auth") ||
        isProviderAuthError(error, "missing-api-key")
          ? "credentials-unavailable"
          : "authentication",
    };
  }
  context.signal.throwIfAborted();
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
    operation: "OpenAI decision",
  });
  const signal = timeoutSignal ?? context.signal;
  const assertActive = () => {
    signal.throwIfAborted();
    if (
      performance.now() >= context.deadlineMonotonicMs ||
      (context.isAdmissible && !context.isAdmissible())
    ) {
      throw new Error("OpenAI decision is no longer admitted.");
    }
  };
  try {
    const configuredHeaders: Record<string, string> = {};
    try {
      for (const [name, value] of Object.entries(providerConfig?.headers ?? {})) {
        const resolved = normalizeResolvedSecretInputString({
          value,
          path: `models.providers.openai.headers.${name}`,
          defaults: config.secrets?.defaults,
        });
        if (resolved !== undefined) {
          configuredHeaders[name] = resolved;
        }
      }
    } catch {
      return { status: "unavailable", reason: "credentials-unavailable" };
    }
    const { baseUrl, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
      baseUrl: endpointKind === "platform" ? OPENAI_API_BASE_URL : configuredBaseUrl,
      defaultBaseUrl: OPENAI_API_BASE_URL,
      defaultHeaders: {
        Authorization: `Bearer ${auth.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      headers: configuredHeaders,
      request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
      provider: "openai",
      capability: "other",
      transport: "http",
    });
    const url = `${baseUrl.replace(/\/$/, "")}/decisions`;
    const request = {
      url,
      signal,
      beforeRequest: assertActive,
      maxRedirects: 0,
      dispatcherPolicy,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: context.model,
          input: text(batch.state),
          questions: questions(batch),
        }),
      },
    };
    const { response, release } = await fetchWithSsrFGuard(
      !dispatcherPolicy && shouldUseEnvHttpProxyForUrl(url)
        ? withTrustedEnvProxyGuardedFetchMode(request)
        : request,
    );
    try {
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          return { status: "unavailable", reason: "authentication" };
        }
        if (response.status === 429) {
          const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
          return {
            status: "unavailable",
            reason: "rate-limited",
            ...(seconds === undefined ? {} : { retryAfterMs: seconds * 1000 }),
          };
        }
        return {
          status: "unavailable",
          reason: [400, 413, 422].includes(response.status) ? "unsupported-input" : "transport",
        };
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readProviderJsonObjectResponse(response, "OpenAI decision", {
          maxBytes: 1_048_576,
          signal,
          requestHeaders: headers,
        });
      } catch {
        signal.throwIfAborted();
        return { status: "unavailable", reason: "invalid-response" };
      }
      assertActive();
      // Vendor-controlled names/model strings must not reflect the active credential.
      if (JSON.stringify(payload).includes(auth.apiKey)) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      return parseResult(batch, payload);
    } finally {
      await release();
    }
  } catch {
    context.signal.throwIfAborted();
    return { status: "unavailable", reason: "transport" };
  } finally {
    cleanup();
  }
}
