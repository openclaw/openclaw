// Vercel AI Gateway typed decision provider implementation.
import type {
  DecisionBatch,
  DecisionBatchResult,
  DecisionProviderV1,
  ProviderDecisionOutcome,
} from "openclaw/plugin-sdk/decisions";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { VERCEL_AI_GATEWAY_BASE_URL } from "./models.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CHOICE_OPTIONS = 255;
const MAX_SCORE_LEVELS = 10;
// Same bound as the TypeSafe transport; the reader stops at the limit instead of buffering the rest.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_DECISION_MODEL = "typesafe-ai/jev";

export type VercelAiGatewayDecisionConfig = {
  apiKey?: string;
  revision?: number;
  baseUrl?: string;
  timeoutMs?: number;
};

class CredentialUnavailableError extends Error {
  constructor(message = "Credentials unavailable") {
    super(message);
    this.name = "CredentialUnavailableError";
  }
}

class InvalidResponseError extends Error {
  constructor(message = "Invalid Vercel AI Gateway evaluation response") {
    super(message);
    this.name = "InvalidResponseError";
  }
}

type VercelEvaluationRawAnswer =
  | {
      type: "boolean";
      probability: number;
    }
  | {
      type: "choice";
      choice: string;
      probabilities?: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      probabilities?: Record<string, number>;
    };

type VercelEvaluationResponseBody = {
  answers?: Record<string, VercelEvaluationRawAnswer>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  providerMetadata?: {
    typesafe?: {
      confidence?: Record<string, number>;
    };
  };
};

export function createVercelAiGatewayDecisionProvider(
  getConfig: () => VercelAiGatewayDecisionConfig,
): DecisionProviderV1 {
  return {
    id: "vercel-ai-gateway",
    contractVersion: 1,
    isReady: () => Boolean(getConfig().apiKey),
    async evaluate(batch: DecisionBatch, context): Promise<ProviderDecisionOutcome> {
      context.signal.throwIfAborted();

      const config = getConfig();
      const apiKey = config.apiKey;
      const initialRevision = config.revision;
      if (!apiKey) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }

      const remainingMs = context.deadlineMonotonicMs - performance.now();
      if (remainingMs <= 0) {
        return { status: "unavailable", reason: "transport" };
      }

      // Validate choice / score bounds before sending
      for (const question of Object.values(batch.questions)) {
        if (question.type === "choice") {
          if (Object.keys(question.criteria).length > MAX_CHOICE_OPTIONS) {
            return { status: "unavailable", reason: "unsupported-input" };
          }
        } else if (question.type === "score") {
          if (question.criteria.length > MAX_SCORE_LEVELS) {
            return { status: "unavailable", reason: "unsupported-input" };
          }
        }
      }

      const timeoutMs = Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, remainingMs);
      const { signal, cleanup } = buildTimeoutAbortSignal({
        signal: context.signal,
        timeoutMs,
        operation: "Vercel AI Gateway decision evaluation",
      });

      const baseUrl = config.baseUrl ?? VERCEL_AI_GATEWAY_BASE_URL;
      const endpoint = `${baseUrl}/v4/ai/evaluation-model`;
      const model = context.model || DEFAULT_DECISION_MODEL;

      // The gateway rejects a question without instructions (null included) with HTTP 400,
      // while the Decision contract makes them optional. Choice and score questions carry their
      // meaning in criteria and accept an empty string; a boolean question still needs real
      // instructions, so the gateway keeps rejecting it as unsupported input. A null prototype
      // keeps "__proto__" an ordinary question ID.
      const questions: Record<string, unknown> = Object.create(null);
      for (const [id, question] of Object.entries(batch.questions)) {
        questions[id] = { ...question, instructions: question.instructions ?? "" };
      }
      const bodyPayload = JSON.stringify({
        state: batch.state,
        questions,
        providerOptions: {},
      });

      const assertCurrentCredentials = () => {
        context.signal.throwIfAborted();
        const current = getConfig();
        if (
          !current.apiKey ||
          current.apiKey !== apiKey ||
          (initialRevision !== undefined && current.revision !== initialRevision)
        ) {
          throw new CredentialUnavailableError(
            "Credentials withdrawn or modified prior to dispatch",
          );
        }
      };

      try {
        const guarded = await fetchWithSsrFGuard(
          withTrustedEnvProxyGuardedFetchMode({
            url: endpoint,
            fetchImpl: globalThis.fetch,
            beforeRequest: assertCurrentCredentials,
            init: {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                "ai-evaluation-model-specification-version": "4",
                "ai-gateway-auth-method": "api-key",
                "ai-gateway-protocol-version": "0.0.1",
                "ai-model-id": model,
              },
              body: bodyPayload,
              signal,
            },
          }),
        );

        let body: Buffer | undefined;
        let responseStatus: number;
        let responseOk: boolean;
        let retryAfterHeader: string | null;

        try {
          const response = guarded.response;
          responseStatus = response.status;
          responseOk = response.ok;
          retryAfterHeader = response.headers.get("retry-after");

          if (responseOk) {
            body = await readResponseWithLimit(response, MAX_RESPONSE_BYTES, {
              signal,
              onOverflow: () =>
                new InvalidResponseError("Vercel AI Gateway evaluation response exceeds its limit"),
            });
          } else {
            await response.body?.cancel();
          }
        } finally {
          await guarded.release();
        }

        if (!responseOk) {
          if (responseStatus === 401 || responseStatus === 403) {
            return { status: "unavailable", reason: "authentication" };
          }
          if (responseStatus === 429) {
            const seconds = parseRetryAfterHeaderSeconds(retryAfterHeader);
            const retryAfterMs = seconds !== undefined ? seconds * 1000 : undefined;
            return {
              status: "unavailable",
              reason: "rate-limited",
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            };
          }
          if (responseStatus === 400) {
            return { status: "unavailable", reason: "unsupported-input" };
          }
          return { status: "unavailable", reason: "transport" };
        }

        context.signal.throwIfAborted();

        let data: VercelEvaluationResponseBody | undefined;
        try {
          // Parsed JSON is untrusted; every field below is validated before use.
          data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
        } catch {
          return { status: "unavailable", reason: "invalid-response" };
        }

        if (
          !data ||
          typeof data !== "object" ||
          !data.answers ||
          typeof data.answers !== "object"
        ) {
          return { status: "unavailable", reason: "invalid-response" };
        }

        const confidenceMap = data.providerMetadata?.typesafe?.confidence;
        const answers: Record<string, DecisionBatchResult["answers"][string]> = Object.create(null);

        for (const [id, question] of Object.entries(batch.questions)) {
          if (!data.answers || !Object.hasOwn(data.answers, id)) {
            return { status: "unavailable", reason: "invalid-response" };
          }
          const rawAnswer = data.answers[id];
          if (!rawAnswer || typeof rawAnswer !== "object" || rawAnswer.type !== question.type) {
            return { status: "unavailable", reason: "invalid-response" };
          }

          const confidenceVal =
            confidenceMap && typeof confidenceMap === "object" && Object.hasOwn(confidenceMap, id)
              ? confidenceMap[id]
              : undefined;
          const confidence =
            typeof confidenceVal === "number" && Number.isFinite(confidenceVal)
              ? confidenceVal
              : undefined;

          if (question.type === "boolean") {
            if (
              rawAnswer.type !== "boolean" ||
              typeof rawAnswer.probability !== "number" ||
              !Number.isFinite(rawAnswer.probability) ||
              rawAnswer.probability < 0 ||
              rawAnswer.probability > 1
            ) {
              return { status: "unavailable", reason: "invalid-response" };
            }
            answers[id] = {
              type: "boolean",
              probabilityTrue: rawAnswer.probability,
            };
          } else if (question.type === "choice") {
            if (
              rawAnswer.type !== "choice" ||
              typeof rawAnswer.choice !== "string" ||
              !Object.hasOwn(question.criteria, rawAnswer.choice)
            ) {
              return { status: "unavailable", reason: "invalid-response" };
            }
            const rawProbabilities = rawAnswer.probabilities;
            if (
              !rawProbabilities ||
              typeof rawProbabilities !== "object" ||
              Array.isArray(rawProbabilities)
            ) {
              return { status: "unavailable", reason: "invalid-response" };
            }
            const expectedKeys = Object.keys(question.criteria);
            const probKeys = Object.keys(rawProbabilities);
            if (probKeys.length !== expectedKeys.length) {
              return { status: "unavailable", reason: "invalid-response" };
            }
            let hasNonZero = false;
            for (const key of expectedKeys) {
              if (!Object.hasOwn(rawProbabilities, key)) {
                return { status: "unavailable", reason: "invalid-response" };
              }
              const prob = rawProbabilities[key];
              if (typeof prob !== "number" || !Number.isFinite(prob) || prob < 0 || prob > 1) {
                return { status: "unavailable", reason: "invalid-response" };
              }
              if (prob > 0) {
                hasNonZero = true;
              }
            }
            if (!hasNonZero) {
              return { status: "unavailable", reason: "invalid-response" };
            }
            answers[id] = {
              type: "choice",
              choice: rawAnswer.choice,
              probabilities: rawProbabilities,
              ...(confidence !== undefined ? { confidence } : {}),
            };
          } else if (question.type === "score") {
            if (rawAnswer.type !== "score") {
              return { status: "unavailable", reason: "invalid-response" };
            }
            const probsRecord = rawAnswer.probabilities;
            if (
              typeof rawAnswer.score !== "number" ||
              !Number.isFinite(rawAnswer.score) ||
              rawAnswer.score < 0 ||
              rawAnswer.score > question.criteria.length - 1 ||
              !probsRecord ||
              typeof probsRecord !== "object" ||
              Array.isArray(probsRecord)
            ) {
              return { status: "unavailable", reason: "invalid-response" };
            }
            const probabilities: number[] = [];
            for (let i = 0; i < question.criteria.length; i++) {
              if (!Object.hasOwn(probsRecord, String(i))) {
                return { status: "unavailable", reason: "invalid-response" };
              }
              const val = probsRecord[String(i)];
              if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 1) {
                return { status: "unavailable", reason: "invalid-response" };
              }
              probabilities.push(val);
            }
            if (!probabilities.some((v) => v > 0)) {
              return { status: "unavailable", reason: "invalid-response" };
            }
            answers[id] = {
              type: "score",
              score: rawAnswer.score,
              probabilities,
              ...(confidence !== undefined ? { confidence } : {}),
            };
          }
        }

        const inputTokens =
          typeof data.usage?.inputTokens === "number" &&
          Number.isFinite(data.usage.inputTokens) &&
          data.usage.inputTokens >= 0
            ? data.usage.inputTokens
            : undefined;
        const outputTokens =
          typeof data.usage?.outputTokens === "number" &&
          Number.isFinite(data.usage.outputTokens) &&
          data.usage.outputTokens >= 0
            ? data.usage.outputTokens
            : undefined;
        const usage =
          inputTokens !== undefined || outputTokens !== undefined
            ? {
                ...(inputTokens !== undefined ? { inputTokens } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
              }
            : undefined;

        return {
          status: "ok",
          result: {
            model,
            answers,
            ...(usage ? { usage } : {}),
          },
        };
      } catch (error) {
        context.signal.throwIfAborted();
        if (error instanceof CredentialUnavailableError) {
          return { status: "unavailable", reason: "credentials-unavailable" };
        }
        if (error instanceof InvalidResponseError) {
          return { status: "unavailable", reason: "invalid-response" };
        }
        return { status: "unavailable", reason: "transport" };
      } finally {
        cleanup();
      }
    },
  };
}
