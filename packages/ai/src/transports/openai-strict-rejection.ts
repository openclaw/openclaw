import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getAiTransportHost, type OpenAIStrictToolRoute } from "../host.js";

// A route that declares compat.supportsStrictMode (config or provider catalog) is never second-guessed.
function declaresStrictMode(model: Model): boolean {
  return isRecord(model.compat) && model.compat.supportsStrictMode !== undefined;
}

// The configured provider is part of the route: two providers can reach different tenants
// through the same URL and model.
function strictToolRoute(model: Model): OpenAIStrictToolRoute {
  return {
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl ?? "",
    model: model.id,
  };
}

/** The same route with strict tools off: tools go out non-strict, with their own schemas. */
export function withoutStrictTools<M extends Model>(model: M): M {
  return { ...model, compat: { ...model.compat, supportsStrictMode: false } };
}

/** An undeclared route that rejected strict tools before keeps them off. */
export async function resolveStrictToolModel<M extends Model>(model: M): Promise<M> {
  const rejections = getAiTransportHost().strictToolRejections;
  if (declaresStrictMode(model) || !rejections) {
    return model;
  }
  const rejected = await rejections.has(strictToolRoute(model)).catch(() => false);
  return rejected ? withoutStrictTools(model) : model;
}

// OpenAI's strict refusal: 400 invalid_function_parameters, param tools[n].parameters,
// "Invalid schema for function '<name>': ... additionalProperties must be false for a strict
// schema". Other endpoints name strict or the tool schema the same way.
const STRICT_REJECTION =
  /invalid_function_parameters|invalid schema for function|\bstrict\b|json_schema|additionalProperties|\btools\[\d+\]/i;
// Account, quota, rate and size errors are never strict refusals, whatever status a proxy uses.
const NOT_STRICT_REJECTION =
  /insufficient_quota|quota|billing|credit|invalid_api_key|unauthori[sz]ed|authentication|permission|rate_limit|rate limit|too many requests|context_length_exceeded|maximum context/i;

/** The provider's own description of a refused request: code, type, param and message. */
function describeProviderError(error: unknown): string {
  if (!isRecord(error)) {
    return "";
  }
  const body = isRecord(error.error) ? error.error : {};
  return [body.code, body.type, body.param, body.message, error.code, error.param, error.message]
    .filter((part) => typeof part === "string")
    .join(" ");
}

/**
 * True when a request refused before any output is a strict-tool rejection worth one retry
 * without strict tools: a 400 or 422 whose error names strict or the tool schema, on an
 * undeclared route whose request carried a strict tool.
 */
export function isStrictToolRetryCandidate(
  model: Model,
  tools: readonly unknown[] | undefined,
  error: unknown,
): boolean {
  const status = isRecord(error) ? error.status : undefined;
  const description = describeProviderError(error);
  return (
    (status === 400 || status === 422) &&
    STRICT_REJECTION.test(description) &&
    !NOT_STRICT_REJECTION.test(description) &&
    !declaresStrictMode(model) &&
    (tools ?? []).some(
      (tool) =>
        isRecord(tool) &&
        (tool.strict === true || (isRecord(tool.function) && tool.function.strict === true)),
    )
  );
}

/**
 * The retry without strict tools after a strict-specific rejection was accepted, so the route
 * rejects them: remember it and warn once.
 */
export async function recordStrictToolRejection(model: Model): Promise<void> {
  const host = getAiTransportHost();
  const firstRecord =
    (await host.strictToolRejections?.record(strictToolRoute(model)).catch(() => false)) ?? true;
  if (firstRecord) {
    host.logWarn(
      "openai-transport",
      `${model.provider}/${model.id} rejected strict tool schemas; sending them non-strict. ` +
        "Set compat.supportsStrictMode: false on this model to skip the first attempt.",
      { provider: model.provider, api: model.api, model: model.id },
    );
  }
}
