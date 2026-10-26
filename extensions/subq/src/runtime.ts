import { isDeepStrictEqual } from "node:util";
import type {
  DecisionBatch,
  DecisionBatchResult,
  DecisionProviderV1,
  ProviderDecisionOutcome,
  ProviderFailureReason,
} from "openclaw/plugin-sdk/decisions";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  responseWithRelease,
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "../openclaw.plugin.json" with { type: "json" };

const MODEL = manifest.decisionModels[0]!.id;
const LIMITS = manifest.decisionModels[0]!.capabilities;
const ENDPOINT = "https://api.subq.ai/v1/systemone";
// The shared Decision runtime admits at most 1 MiB. Also bound the vendor response.
const MAX_BYTES = 1024 * 1024;
type Context = Parameters<DecisionProviderV1["evaluate"]>[1];
const unavailable = (reason: ProviderFailureReason): ProviderDecisionOutcome => ({
  status: "unavailable",
  reason,
});

function supports(batch: DecisionBatch, model: string): boolean {
  const questions = Object.entries(batch.questions);
  return (
    model === MODEL &&
    batch.state !== null &&
    questions.length > 0 &&
    questions.length <= LIMITS.maxQuestions &&
    questions.every(([id, question]) => {
      if (id.length > 100) {
        return false;
      }
      if (question.type === "choice") {
        const count = Object.keys(question.criteria).length;
        return count >= 2 && count <= LIMITS.maxChoiceAlternatives;
      }
      if (question.type === "score") {
        return question.criteria.length >= 2 && question.criteria.length <= LIMITS.maxScoreLevels;
      }
      return true;
    })
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Invalid SubQ response.");
  }
  return value;
}

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Invalid SubQ probability.");
  }
  return value;
}

/** Translate the documented wire contract; the host also validates the resulting Decision batch. */
function parseResult(payload: unknown, batch: DecisionBatch): DecisionBatchResult {
  const result = record(payload);
  const wireAnswers = record(result.answers);
  if (
    result.model !== MODEL ||
    Object.keys(wireAnswers).length !== Object.keys(batch.questions).length
  ) {
    throw new Error("Invalid SubQ result.");
  }
  const answers: Record<string, DecisionBatchResult["answers"][string]> = Object.create(null);
  for (const [id, question] of Object.entries(batch.questions)) {
    const answer = record(wireAnswers[id]);
    if (question.type === "boolean") {
      if (answer.type !== "noul") {
        throw new Error("Invalid SubQ answer type.");
      }
      answers[id] = { type: "boolean", probabilityTrue: probability(answer.noul) };
      continue;
    }
    if (answer.type !== question.type) {
      throw new Error("Invalid SubQ answer type.");
    }
    const labels =
      question.type === "score"
        ? question.criteria.map((_, i) => String(i))
        : Object.keys(question.criteria);
    const distribution = record(answer.probabilities);
    if (
      Object.keys(distribution).length !== labels.length ||
      labels.some((key) => !Object.hasOwn(distribution, key))
    ) {
      throw new Error("Invalid SubQ distribution.");
    }
    const probabilities = labels.map((key) => probability(distribution[key]));
    if (!probabilities.some((p) => p > 0)) {
      throw new Error("Invalid SubQ distribution.");
    }
    const confidence = answer.confidence === undefined ? undefined : probability(answer.confidence);
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !labels.includes(answer.choice)) {
        throw new Error("Invalid SubQ choice.");
      }
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: Object.fromEntries(labels.map((key, i) => [key, probabilities[i]!])),
        ...(confidence === undefined ? {} : { confidence }),
      };
    } else {
      const legend = record(answer.legend);
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > labels.length - 1 ||
        Object.keys(legend).length !== labels.length ||
        labels.some((key, i) => !isDeepStrictEqual(legend[key], question.criteria[i]))
      ) {
        throw new Error("Invalid SubQ score.");
      }
      answers[id] = {
        type: "score",
        score: answer.score,
        probabilities,
        ...(confidence === undefined ? {} : { confidence }),
      };
    }
  }
  const usage = record(result.usage);
  const inputTokens = usage.input_tokens;
  if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    throw new Error("Invalid SubQ usage.");
  }
  if (usage.output_tokens !== 0) {
    throw new Error("Invalid SubQ output usage.");
  }
  return { model: MODEL, answers, usage: { inputTokens, outputTokens: 0 } };
}

export async function evaluate(
  batch: DecisionBatch,
  context: Context,
  apiKey: string,
): Promise<ProviderDecisionOutcome> {
  context.signal.throwIfAborted();
  if (!supports(batch, context.model)) {
    return unavailable("unsupported-input");
  }
  const body = JSON.stringify({
    model: context.model,
    state: batch.state,
    questions: Object.fromEntries(
      Object.entries(batch.questions).map(([id, question]) => [
        id,
        question.type === "boolean" ? { ...question, type: "noul" } : question,
      ]),
    ),
  });
  if (Buffer.byteLength(body) > MAX_BYTES) {
    return unavailable("unsupported-input");
  }
  const remaining = context.deadlineMonotonicMs - performance.now();
  if (remaining <= 0) {
    return unavailable("transport");
  }
  const { signal, cleanup } = buildTimeoutAbortSignal({
    signal: context.signal,
    timeoutMs: Math.ceil(remaining),
    operation: "SubQ evaluation",
  });
  let authorityFailure: { error: unknown } | undefined;
  const assertActive = () => {
    signal?.throwIfAborted();
    let admitted: boolean | undefined;
    try {
      admitted = context.isAdmissible?.();
    } catch (error) {
      authorityFailure = { error };
      throw error;
    }
    if (performance.now() >= context.deadlineMonotonicMs || admitted === false) {
      throw new Error("SubQ evaluation is no longer admitted.");
    }
  };
  try {
    assertActive();
    const request = {
      url: ENDPOINT,
      requireHttps: true,
      maxRedirects: 0,
      signal,
      beforeRequest: assertActive,
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
      },
    };
    const guarded = await fetchWithSsrFGuard(
      shouldUseEnvHttpProxyForUrl(ENDPOINT)
        ? withTrustedEnvProxyGuardedFetchMode(request)
        : request,
    );
    let releasePromise: Promise<void> | undefined;
    const release = () => (releasePromise ??= Promise.resolve().then(() => guarded.release()));
    try {
      const response = responseWithRelease(guarded.response, release);
      if (!response.ok) {
        // Error bodies can echo credentials/state; never read them or surface vendor diagnostics.
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          return unavailable("authentication");
        }
        if (response.status === 429) {
          const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
          return {
            status: "unavailable",
            reason: "rate-limited",
            ...(seconds === undefined ? {} : { retryAfterMs: seconds * 1000 }),
          };
        }
        return unavailable(
          [400, 413, 422].includes(response.status) ? "unsupported-input" : "transport",
        );
      }
      try {
        const bytes = await readResponseWithLimit(response, MAX_BYTES, { signal });
        context.signal.throwIfAborted();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes(apiKey)) {
          return unavailable("invalid-response");
        }
        return { status: "ok", result: parseResult(JSON.parse(text), batch) };
      } catch {
        context.signal.throwIfAborted();
        return unavailable(signal?.aborted ? "transport" : "invalid-response");
      }
    } finally {
      await release();
    }
  } catch {
    context.signal.throwIfAborted();
    if (authorityFailure) {
      throw authorityFailure.error;
    }
    return unavailable("transport");
  } finally {
    cleanup();
  }
}
