import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  decodeSystemOneResponse,
  encodeSystemOneQuestions,
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionProviderContextV2,
  type DecisionProviderV2,
} from "openclaw/plugin-sdk/decisions";
import {
  fetchWithProviderHttpGuard,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  resolveProviderTransportSsrFPolicy,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const PROVIDER_ID = "cloudflare-workers-ai";
const MODEL_ID = "@cf/cloudflare/clef";

function supportsBatch(batch: DecisionBatchV2): boolean {
  if (!validateDecisionBatchV2(batch) || batch.state.type === "list") {
    return false;
  }
  if (
    batch.state.type === "json" &&
    (batch.state.value === null ||
      (typeof batch.state.value !== "string" && typeof batch.state.value !== "object"))
  ) {
    return false;
  }
  const questions = Object.entries(batch.questions);
  return (
    questions.length <= 64 &&
    questions.every(([id, question]) => {
      if (
        !/^[a-zA-Z0-9_.-]{1,100}$/.test(id) ||
        question.instructions == null ||
        (typeof question.instructions === "string" && !question.instructions.trim())
      ) {
        return false;
      }
      if (question.type === "choice") {
        return Object.keys(question.criteria).length <= 255;
      }
      if (question.type === "score") {
        return question.criteria.length <= 10 && question.criteria.every((level) => level !== null);
      }
      return question.type === "boolean" && question.criteria !== null;
    })
  );
}

function hasUnsupportedParams(context: DecisionProviderContextV2): boolean {
  const { config, agentId, model } = context;
  const agent = agentId ? resolveAgentConfig(config, agentId) : undefined;
  const modelRef = `${PROVIDER_ID}/${model.id}`;
  // Native Clef has no chat generation or routing params. Reject authored controls
  // instead of silently dropping limits or privacy policy from another config layer.
  return [
    config.models?.providers?.[PROVIDER_ID]?.params,
    model.params,
    config.agents?.defaults?.params,
    config.agents?.defaults?.models?.[modelRef]?.params,
    agent?.models?.[modelRef]?.params,
    agent?.params,
  ].some((params) => Object.values(params ?? {}).some((value) => value !== undefined));
}

function decodeResult(batch: DecisionBatchV2, value: unknown): unknown {
  const envelope = asOptionalRecord(value);
  const result = asOptionalRecord(envelope?.result);
  const answers = asOptionalRecord(result?.answers);
  if (envelope?.success !== true || !answers) {
    return undefined;
  }
  // Clef requires categorical distributions and a zero-based score legend; the
  // shared System One codec also serves vendors where the legend is optional.
  for (const [id, question] of Object.entries(batch.questions)) {
    const answer = asOptionalRecord(answers[id]);
    if (question.type === "choice" && !asOptionalRecord(answer?.probabilities)) {
      return undefined;
    }
    if (question.type === "score") {
      const legend = asOptionalRecord(answer?.legend);
      if (
        !legend ||
        Object.keys(legend).length !== question.criteria.length ||
        !question.criteria.every((_, index) => Object.hasOwn(legend, String(index)))
      ) {
        return undefined;
      }
    }
  }
  return decodeSystemOneResponse(batch, result);
}

export function buildWorkersAiDecisionProvider(deps: {
  getImageMetadata: (buffer: Buffer) => Promise<{ width: number; height: number } | null>;
}): DecisionProviderV2 {
  return {
    id: PROVIDER_ID,
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const configured = context.config.models?.providers?.[PROVIDER_ID];
      const baseUrl = context.model.baseUrl;
      if (
        context.model.id !== MODEL_ID ||
        !baseUrl ||
        (context.reasoning !== undefined && context.reasoning !== "auto") ||
        hasUnsupportedParams(context) ||
        !supportsBatch(batch)
      ) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      if (!context.auth.apiKey && !context.model.headers) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      let release: (() => Promise<void>) | undefined;
      let admissionError: { error: unknown } | undefined;
      const assertActive = () => {
        context.signal.throwIfAborted();
        let admitted: boolean;
        try {
          admitted = context.isAdmissible();
        } catch (error) {
          admissionError = { error };
          throw error;
        }
        if (!admitted || performance.now() >= context.deadlineMonotonicMs) {
          throw new Error("Cloudflare Decision is no longer admitted.");
        }
      };
      try {
        assertActive();
        if (batch.state.type === "image") {
          const metadata = await deps.getImageMetadata(
            Buffer.from(batch.state.dataUri.split(",", 2)[1]!, "base64"),
          );
          assertActive();
          if (
            !metadata ||
            metadata.width <= 0 ||
            metadata.height <= 0 ||
            metadata.width * metadata.height > 16_000_000
          ) {
            return { status: "unavailable", reason: "unsupported-input" };
          }
        }
        const body = JSON.stringify({
          model: "clef",
          state:
            batch.state.type === "text"
              ? batch.state.text
              : batch.state.type === "json"
                ? batch.state.value
                : batch.state.type === "image"
                  ? (batch.state.text ?? "")
                  : undefined,
          ...(batch.state.type === "image" ? { images: [batch.state.dataUri] } : {}),
          questions: encodeSystemOneQuestions(batch),
        });
        const configuredRequest = configured?.request;
        // Core has already selected and protected credentials. Only transport policy
        // is read here, so authored auth cannot overwrite the prepared identity.
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
          provider: PROVIDER_ID,
          capability: "llm",
          transport: "http",
          baseUrl,
          defaultBaseUrl: baseUrl,
          defaultHeaders: {
            "Content-Type": "application/json",
            ...(context.auth.apiKey &&
            (!configuredRequest?.auth || configuredRequest.auth.mode === "provider-default")
              ? { Authorization: `Bearer ${context.auth.apiKey}` }
              : {}),
          },
          headers: context.model.headers,
          request,
        });
        const url = requestConfig.baseUrl.replace(/\/+$/u, "") + `/run/${MODEL_ID}`;
        assertActive();
        const guarded = await fetchWithProviderHttpGuard({
          url,
          init: { method: "POST", headers: requestConfig.headers, body },
          signal: context.signal,
          timeoutMs: context.deadlineMonotonicMs - performance.now(),
          beforeRequest: assertActive,
          policy: resolveProviderTransportSsrFPolicy({
            baseUrl: requestConfig.baseUrl,
            url,
            allowPrivateNetwork: requestConfig.allowPrivateNetwork,
            trustConfiguredBaseUrlOrigin: configuredRequest?.allowPrivateNetwork !== false,
          }),
          dispatcherPolicy: requestConfig.dispatcherPolicy,
          auditContext: "cloudflare-workers-ai-decisions",
        });
        release = guarded.release;
        const response = guarded.response;
        if (!response.ok) {
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
          };
        }
        let value: unknown;
        try {
          value = await readProviderJsonResponse(response, "Cloudflare decisions", {
            maxBytes: 1_048_576,
            timeoutMs: Math.max(1, context.deadlineMonotonicMs - performance.now()),
          });
        } catch {
          context.signal.throwIfAborted();
          return { status: "unavailable", reason: "invalid-response" };
        }
        assertActive();
        const result = decodeResult(batch, value);
        return validateDecisionResultV2(batch, result, context.model.inference?.decision)
          ? { status: "ok", result }
          : { status: "unavailable", reason: "invalid-response" };
      } catch {
        context.signal.throwIfAborted();
        if (admissionError) {
          throw admissionError.error;
        }
        return { status: "unavailable", reason: "transport" };
      } finally {
        await release?.();
      }
    },
  };
}
