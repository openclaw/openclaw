import {
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionAnswerV2,
  type DecisionBatchV2,
  type DecisionProviderV2,
  type DecisionQuestionV2,
  type JsonValue,
} from "openclaw/plugin-sdk/decisions";
import {
  createProviderOperationDeadline,
  ProviderHttpError,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { executeSageRequest, SageRequestError, SageResponseError } from "./sage-transport.js";
import type { SageImageProbe } from "./sage-validation.js";
import type { SageContent, SageQuestion, SageResponse } from "./sage-wire.js";

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

/** Native executor only: auth discovery, role selection and usage emission belong to the host. */
export function createSageDecisionProvider(probeImage: SageImageProbe): DecisionProviderV2 {
  return {
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
            (q.kind === "scale" && q.levels.length !== 5) ||
            (q.kind === "choice" && q.options.length > (batch.state.type === "image" ? 20 : 120)) ||
            (q.kind === "tags" && q.tags.length > 120)
          ) {
            return { status: "unavailable", reason: "unsupported-input" };
          }
        }
      } catch {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const remaining = context.deadlineMonotonicMs - performance.now();
      if (remaining <= 0) {
        return { status: "unavailable", reason: "transport" };
      }
      const reasoning = context.reasoning === undefined ? {} : { reasoning: context.reasoning };
      const first = questions[0];
      if (!first) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const single = { content: nativeContent, question: first, ...reasoning };
      const batchRequest = { requests: [{ content: nativeContent, questions }], ...reasoning };
      try {
        const route = resolveProviderHttpRequestConfig({
          provider: "levanto",
          baseUrl: context.model.baseUrl,
          defaultBaseUrl: "https://sage.levanto.ai",
          api: context.model.api,
          capability: "other",
          transport: "http",
          headers: context.model.headers,
          defaultHeaders: { Authorization: `Bearer ${context.auth.apiKey}` },
          request: sanitizeConfiguredModelProviderRequest(
            context.config.models?.providers?.levanto?.request,
          ),
        });
        const budget = context.deadlineMonotonicMs - performance.now();
        if (budget <= 0) {
          return { status: "unavailable", reason: "transport" };
        }
        const transport = {
          ...route,
          deadline: createProviderOperationDeadline({ label: "Sage decision", timeoutMs: budget }),
          signal: context.signal,
          fetchFn: globalThis.fetch,
          probeImage,
        };
        const response =
          questions.length === 1
            ? await executeSageRequest(single, transport)
            : await executeSageRequest(batchRequest, transport);
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
          ...(usage ? { usage: { inputTokens: usage.billed_input_tokens, raw: usage } } : {}),
          // Call-level accounting and partial error text stay on an object, never array.meta.
          metadata: { native: response },
        };
        return validateDecisionResultV2(batch, result, context.model.inference?.decision)
          ? { status: "ok", result }
          : { status: "unavailable", reason: "invalid-response" };
      } catch (error) {
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
}
