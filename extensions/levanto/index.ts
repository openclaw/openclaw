import {
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionAnswerV2,
  type DecisionBatchV2,
  type DecisionProviderV2,
  type DecisionQuestionV2,
  type JsonValue,
} from "openclaw/plugin-sdk/decisions";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  assertOkOrThrowProviderError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  ProviderHttpError,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import {
  parseSageBatchResponse,
  parseSageResponse,
  validateSageRequest,
  type SageImageProbe,
} from "./sage-validation.js";
import type {
  SageBatchRequest,
  SageContent,
  SageQuestion,
  SageRequest,
  SageResponse,
} from "./sage-wire.js";

function render(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
function content(state: DecisionBatchV2["state"]): SageContent {
  switch (state.type) {
    case "text":
      return state.text;
    case "json":
      return render(state.value);
    case "image":
      return {
        kind: "image",
        media: state.dataUri,
        ...(state.text === undefined ? {} : { text: state.text }),
      };
    case "list":
      return {
        kind: "list",
        value: state.items.map((item) => ({ id: item.id, content: render(item.content) })),
      };
  }
  throw new Error("Unsupported Sage content");
}
function question(id: string, q: DecisionQuestionV2): SageQuestion {
  const instructions = q.instructions == null ? id : render(q.instructions);
  switch (q.type) {
    case "boolean":
      return {
        id,
        kind: "yesno",
        instructions:
          q.criteria == null
            ? instructions
            : instructions +
              "\nCriteria (true means yes; false means no):\n" +
              JSON.stringify(q.criteria),
      };
    case "choice":
      return {
        id,
        kind: "choice",
        instructions,
        options: Object.entries(q.criteria).map(([option, description]) => ({
          option,
          description: description === null ? null : render(description),
        })),
      };
    case "score":
      return {
        id,
        kind: "scale",
        instructions,
        levels: q.criteria.map((description, level) => ({
          level,
          description: description === null ? null : render(description),
        })),
      };
    case "sort":
      return { id, kind: "sort", instructions };
    case "tags":
      return {
        id,
        kind: "tags",
        ...(q.instructions == null ? {} : { instructions }),
        tags: Object.entries(q.criteria).map(([tagId, description]) =>
          description === null ? { id: tagId } : { id: tagId, name: render(description) },
        ),
      };
    case "box":
      break;
  }
  throw new Error("Unsupported Sage question");
}
function answer(response: SageResponse): DecisionAnswerV2 {
  const metadata = { native: response };
  switch (response.kind) {
    case "yesno":
      return {
        type: "boolean",
        answer: response.result.answer === null ? null : response.result.answer === "yes",
        probabilityTrue: response.result.probability,
        metadata,
      };
    case "choice":
      return {
        type: "choice",
        choice: response.result.chosen,
        probability: response.result.probability,
        probabilities: Object.fromEntries(
          response.result.probabilities.map((p) => [p.option, p.probability]),
        ),
        metadata,
      };
    case "scale":
      return {
        type: "score",
        score: response.result.expectation,
        confidence: response.result.confidence,
        probabilities: response.result.probabilities.map((entry) => entry.probability),
        metadata,
      };
    case "sort":
      return {
        type: "sort",
        order: response.result.sorted,
        ...(response.result.confidence === undefined
          ? {}
          : { confidence: response.result.confidence }),
        metadata,
      };
    case "tags":
      return { type: "tags", tags: response.result.tags, metadata };
  }
  throw new Error("Unsupported Sage response");
}

class SageRequestError extends Error {
  constructor() {
    super("Invalid Sage request");
  }
}
class SageResponseError extends Error {
  constructor() {
    super("Sage: invalid or oversized response");
  }
}

export default definePluginEntry({
  id: "levanto",
  name: "Levanto Sage",
  description: "Native typed decisions with explicit abstention.",
  register(api) {
    const probeImage: SageImageProbe = (bytes) => api.runtime.media.getImageMetadata(bytes);
    const provider: DecisionProviderV2 = {
      id: "levanto",
      contractVersion: 2,
      async evaluate(batch, context) {
        context.signal.throwIfAborted();
        if (
          context.model.provider !== "levanto" ||
          context.model.id !== "levanto-sage" ||
          context.model.api !== undefined
        ) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        if (!context.auth.apiKey) {
          // Effective headers never provide a second credential-discovery route.
          return { status: "unavailable", reason: "credentials-unavailable" };
        }
        let nativeContent: SageContent;
        let questions: SageQuestion[];
        try {
          if (!validateDecisionBatchV2(batch)) {
            return { status: "unavailable", reason: "unsupported-input" };
          }
          nativeContent = content(batch.state);
          questions = Object.entries(batch.questions).map(([id, q]) => question(id, q));
          // Validate vendor-only combinations before media processing or a billable effect.
          for (const q of questions) {
            if (
              (q.kind === "sort" && batch.state.type !== "list") ||
              (q.kind === "scale" && (q.levels.length < 2 || q.levels.length > 26)) ||
              (q.kind === "choice" &&
                q.options.length > (batch.state.type === "image" ? 20 : 120)) ||
              (q.kind === "tags" && q.tags.length > 120)
            ) {
              return { status: "unavailable", reason: "unsupported-input" };
            }
          }
        } catch {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        const remainingBudgetMs = context.deadlineMonotonicMs - performance.now();
        if (remainingBudgetMs <= 0) {
          return { status: "unavailable", reason: "transport" };
        }
        const reasoning = context.reasoning === undefined ? {} : { reasoning: context.reasoning };
        const first = questions[0];
        if (!first) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        const request: SageRequest | SageBatchRequest =
          questions.length === 1
            ? { content: nativeContent, question: first, ...reasoning }
            : { requests: [{ content: nativeContent, questions }], ...reasoning };
        let admissionError: { error: unknown } | undefined;
        try {
          const configuredRequest = resolveMergedModelProviderConfig(
            context.config,
            "levanto",
          )?.request;
          // The host has already resolved header/SecretRef precedence and explicit auth.
          // Only network policy is read here; never resolve or replay configured credentials.
          const networkRequest = sanitizeConfiguredModelProviderRequest({
            proxy: configuredRequest?.proxy,
            tls: configuredRequest?.tls,
            allowPrivateNetwork: configuredRequest?.allowPrivateNetwork,
          });
          const route = resolveProviderHttpRequestConfig({
            provider: "levanto",
            baseUrl: context.model.baseUrl,
            defaultBaseUrl: "https://sage.levanto.ai",
            api: context.model.api,
            capability: "other",
            transport: "http",
            headers: context.model.headers,
            defaultHeaders:
              configuredRequest?.auth?.mode === "header" ||
              configuredRequest?.auth?.mode === "authorization-bearer"
                ? undefined
                : { Authorization: `Bearer ${context.auth.apiKey}` },
            request: networkRequest,
          });
          const budget = context.deadlineMonotonicMs - performance.now();
          if (budget <= 0) {
            return { status: "unavailable", reason: "transport" };
          }
          const deadline = createProviderOperationDeadline({
            label: "Sage decision",
            timeoutMs: budget,
          });
          const beforeRequest = () => {
            let admitted: boolean;
            try {
              admitted = context.isAdmissible();
            } catch (error) {
              // Host authority failures must not become a retryable provider failure.
              admissionError = { error };
              throw error;
            }
            if (!admitted) {
              throw new Error("Sage evaluation is no longer admitted.");
            }
          };
          const response = await (async () => {
            // A finite deadline is mandatory. Never silently substitute the SDK's 60-second timeout.
            if (!Number.isFinite(deadline.deadlineAtMs)) {
              throw new Error("Sage requires a finite operation deadline");
            }
            const remaining = createProviderOperationTimeoutResolver({
              deadline,
              defaultTimeoutMs: 2_147_483_647,
            });
            context.signal?.throwIfAborted();
            remaining();
            const validation = buildTimeoutAbortSignal({
              signal: context.signal,
              timeoutMs: remaining(),
              operation: "Sage input validation",
            });
            const signal = validation.signal;
            try {
              // The normal media owner retains its read-only probe; cancellation must not
              // leave this request waiting for it or allow a later HTTP effect.
              await racePromiseWithAbortSignal(
                () => validateSageRequest(request, probeImage),
                signal,
              );
              signal?.throwIfAborted();
            } catch {
              context.signal?.throwIfAborted();
              signal?.throwIfAborted();
              remaining();
              throw new SageRequestError();
            } finally {
              validation.cleanup();
            }
            context.signal?.throwIfAborted();
            remaining();
            const base = new URL(route.baseUrl);
            if (
              !["https:", "http:"].includes(base.protocol) ||
              base.username ||
              base.password ||
              base.search ||
              base.hash
            ) {
              throw new Error("Invalid Sage base URL");
            }
            // Append to a configured prefix; an absolute /decide would silently escape it.
            base.pathname =
              base.pathname.replace(/\/+$/, "") +
              ("requests" in request ? "/decide/batch" : "/decide");
            const headers = new Headers(route.headers);
            headers.set("content-type", "application/json");
            const guardedRequest = {
              url: base.href,
              init: { method: "POST", headers, body: JSON.stringify(request) },
              timeoutMs: remaining(),
              signal: context.signal,
              fetchImpl: globalThis.fetch,
              dispatcherPolicy: route.dispatcherPolicy,
              policy: route.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
              auditContext: "levanto-sage",
              // Recheck the owner after image validation and DNS, before each HTTP effect.
              beforeRequest,
            };
            // Preserve the provider HTTP helper's implicit proxy policy without retrying a billable POST.
            const result = await fetchWithSsrFGuard(
              !route.dispatcherPolicy && shouldUseEnvHttpProxyForUrl(base.href)
                ? withTrustedEnvProxyGuardedFetchMode(guardedRequest)
                : guardedRequest,
            );
            try {
              await assertOkOrThrowProviderError(result.response, "Sage request failed", {
                signal: context.signal,
                bodyTimeoutMs: remaining,
                requestHeaders: headers,
              });
              try {
                const payload = await readProviderJsonResponse<unknown>(result.response, "Sage", {
                  signal: context.signal,
                  timeoutMs: remaining,
                  requestHeaders: headers,
                });
                const parsed =
                  "requests" in request
                    ? parseSageBatchResponse(payload, request)
                    : parseSageResponse(payload, request.question, request.content);
                // Include decode and validation in the caller's total budget, not just response headers.
                context.signal?.throwIfAborted();
                remaining();
                return parsed;
              } catch {
                context.signal?.throwIfAborted();
                remaining();
                throw new SageResponseError();
              }
            } finally {
              await result.release();
            }
          })();
          context.signal.throwIfAborted();
          if (performance.now() >= context.deadlineMonotonicMs) {
            return { status: "unavailable", reason: "transport" };
          }
          const answers: Record<string, DecisionAnswerV2> = Object.create(null);
          if ("results" in response) {
            const group = response.results[0];
            if (!group) {
              return { status: "unavailable", reason: "invalid-response" };
            }
            questions.forEach((q, index) => {
              const item = group.answers[index];
              if (!item) {
                throw new Error("Missing Sage answer");
              }
              answers[q.id] = item.ok
                ? answer(item.result)
                : { type: "error", code: "provider-error" };
            });
          } else {
            answers[response.id] = answer(response);
          }
          const usage = response.meta.usage;
          const result = {
            model: response.meta.model ?? context.model.id,
            answers,
            ...(usage
              ? {
                  usage: {
                    inputTokens: usage.input_tokens,
                    outputTokens: usage.output_tokens,
                    raw: usage,
                  },
                }
              : {}),
            // Call-level accounting and partial error text stay on an object, never array.meta.
            metadata: { native: response },
          };
          return validateDecisionResultV2(batch, result, context.model.inference?.decision)
            ? { status: "ok", result }
            : { status: "unavailable", reason: "invalid-response" };
        } catch (error) {
          if (admissionError) {
            throw admissionError.error;
          }
          context.signal.throwIfAborted();
          if (error instanceof ProviderHttpError) {
            const reason =
              error.status === 401 || error.status === 403
                ? "authentication"
                : error.status === 429
                  ? "rate-limited"
                  : error.status === 400 || error.status === 413 || error.status === 422
                    ? "unsupported-input"
                    : "transport";
            return {
              status: "unavailable",
              reason,
              ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
            };
          }
          return {
            status: "unavailable",
            reason:
              error instanceof SageRequestError
                ? "unsupported-input"
                : error instanceof SageResponseError
                  ? "invalid-response"
                  : "transport",
          };
        }
      },
    };

    api.registerDecisionProvider({
      ...provider,
      provider: {
        label: "Levanto Sage",
        docsPath: "/providers/levanto",
        authScope: "agent",
        envVars: ["LEVANTO_API_KEY"],
        auth: [
          createProviderApiKeyAuthMethod({
            providerId: "levanto",
            methodId: "api-key",
            label: "Levanto API key",
            optionKey: "levantoApiKey",
            flagName: "--levanto-api-key",
            envVar: "LEVANTO_API_KEY",
            promptMessage: "Enter your Levanto API key",
            // Connecting credentials never changes a conversational or decision model selection.
            wizard: {
              choiceId: "levanto-api-key",
              choiceLabel: "Levanto API key",
              groupId: "levanto",
              groupLabel: "Levanto Sage",
              modelTarget: "utility",
            },
          }),
        ],
      },
    });
  },
});
