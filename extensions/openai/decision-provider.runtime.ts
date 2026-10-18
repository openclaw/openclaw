import { getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  DecisionAnswerV2,
  DecisionBatchV2,
  DecisionEntry,
  DecisionProviderV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { validateDecisionBatchV2 } from "openclaw/plugin-sdk/decisions";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  fetchWithProviderHttpGuard,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { classifyOpenAIBaseUrl, OPENAI_API_BASE_URL } from "./base-url.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type Context = Parameters<DecisionProviderV2["evaluate"]>[1];
// The bundled manifest declares one OpenAI Decision model with shared wire limits.
const capability = manifest.modelCatalog.providers.openai.models.find(
  (model) => model.id === "gpt-6-luna",
)!.inference!.decision;
const maxQuestions = capability.limits.maxQuestions;
const maxChoiceAlternatives = capability.questions.choice.maxOptions;

function text(value: DecisionEntry | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

function questions(batch: DecisionBatchV2) {
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
    if (question.type !== "score") {
      throw new Error("Unsupported OpenAI decision question");
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

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseResult(
  batch: DecisionBatchV2,
  payload: Record<string, unknown>,
): ProviderDecisionOutcomeV2 {
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
  const answers: [string, DecisionAnswerV2][] = [];
  for (const [index, [name, question]] of entries.entries()) {
    const answer: unknown = payload.answers[index];
    if (!isRecord(answer) || answer.name !== name) {
      return { status: "unavailable", reason: "invalid-response" };
    }
    // Refusals belong to one question; preserve independent successful answers.
    if (answer.type === "refusal") {
      answers.push([name, { type: "error", code: "provider-error", providerCode: "refusal" }]);
      continue;
    }
    if (question.type === "boolean") {
      if (answer.type !== "predicate" || !probability(answer.probability)) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      answers.push([name, { type: "boolean", probabilityTrue: answer.probability }]);
      continue;
    }
    if (question.type !== "choice" && question.type !== "score") {
      return { status: "unavailable", reason: "invalid-response" };
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
      const label = isRecord(item)
        ? item[question.type === "choice" ? "value" : "label"]
        : undefined;
      if (
        !isRecord(item) ||
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
    !isRecord(usage) ||
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
  batch: DecisionBatchV2,
  context: Context,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  // Keep direct adapter calls inside the same envelope declared by the catalog.
  // Credential selection belongs to the prepared host, never this transport.
  const entries = Object.values(batch.questions);
  if (
    !validateDecisionBatchV2(batch) ||
    (batch.state.type !== "text" && batch.state.type !== "json" && batch.state.type !== "image") ||
    (context.reasoning !== undefined && context.reasoning !== "auto") ||
    entries.length > maxQuestions ||
    entries.some((question) => !["boolean", "choice", "score"].includes(question.type)) ||
    entries.some(
      (question) =>
        question.type === "choice" && Object.keys(question.criteria).length > maxChoiceAlternatives,
    )
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const configuredBaseUrl = context.model.baseUrl;
  const endpointKind = classifyOpenAIBaseUrl(configuredBaseUrl);
  if (
    context.model.api !== "openai-responses" ||
    endpointKind === "chatgpt" ||
    endpointKind === "invalid" ||
    endpointKind === "unresolved"
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
    operation: "OpenAI decision",
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
    if (performance.now() >= context.deadlineMonotonicMs || !admitted) {
      throw new Error("OpenAI decision is no longer admitted.");
    }
  };
  try {
    const preparedRequest = getModelProviderRequestTransport(context.model);
    const { baseUrl, headers, dispatcherPolicy, allowPrivateNetwork } =
      resolveProviderHttpRequestConfig({
        baseUrl: endpointKind === "platform" ? OPENAI_API_BASE_URL : configuredBaseUrl,
        defaultBaseUrl: OPENAI_API_BASE_URL,
        defaultHeaders: {
          // Prepared auth overrides already own the header; never restore a removed bearer.
          ...(!preparedRequest?.auth || preparedRequest.auth.mode === "provider-default"
            ? { Authorization: `Bearer ${auth.apiKey}` }
            : {}),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        headers: context.model.headers,
        request: preparedRequest
          ? {
              proxy: preparedRequest.proxy,
              tls: preparedRequest.tls,
              allowPrivateNetwork: preparedRequest.allowPrivateNetwork,
            }
          : undefined,
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
      policy: { allowPrivateNetwork },
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: context.model.id,
          input:
            batch.state.type === "image"
              ? [
                  {
                    role: "user",
                    content: [
                      ...(batch.state.text ? [{ type: "input_text", text: batch.state.text }] : []),
                      { type: "input_image", image_url: batch.state.dataUri },
                    ],
                  },
                ]
              : batch.state.type === "text"
                ? batch.state.text
                : JSON.stringify(batch.state.value),
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
    if (admissionError) {
      throw admissionError.error;
    }
    return { status: "unavailable", reason: "transport" };
  } finally {
    cleanup();
  }
}
