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

// Account, quota, rate and size failures, whatever status a proxy reports them with.
const NOT_STRICT_CODE =
  /insufficient_quota|quota|billing|invalid_api_key|unauthori[sz]ed|authentication|permission|rate_limit|context_length_exceeded/i;
// OpenAI's strict refusal: code invalid_function_parameters, param tools[n].parameters.
const STRICT_CODE = /^invalid_function_parameters$/;
const STRICT_PARAM = /^tools\[\d+\]/;
// Without structured fields: "Invalid schema for function '<name>': ... additionalProperties
// must be false for a strict schema", or another endpoint naming strict or the tool schema.
const STRICT_MESSAGE = /invalid schema for function|\bstrict\b|json_schema|additionalProperties/i;
const NOT_STRICT_MESSAGE =
  /insufficient_quota|exceeded your current quota|invalid_api_key|incorrect api key|unauthori[sz]ed|rate limit|too many requests|context_length_exceeded|maximum context length/i;

function readString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string") ?? "";
}

/**
 * Whether the provider's error is a strict or tool-schema rejection. Structured fields decide
 * first (an account code vetoes, a strict code or tools[n] param confirms); the message only
 * decides when neither is present, so a tool named like "credit_lookup" cannot veto.
 */
function isStrictRejection(error: Record<string, unknown>): boolean {
  const body = isRecord(error.error) ? error.error : {};
  const code = readString(body.code, error.code);
  const type = readString(body.type, error.type);
  if (NOT_STRICT_CODE.test(code) || NOT_STRICT_CODE.test(type)) {
    return false;
  }
  if (STRICT_CODE.test(code) || STRICT_PARAM.test(readString(body.param, error.param))) {
    return true;
  }
  const message = readString(body.message, error.message);
  return STRICT_MESSAGE.test(message) && !NOT_STRICT_MESSAGE.test(message);
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
  return (
    isRecord(error) &&
    (error.status === 400 || error.status === 422) &&
    isStrictRejection(error) &&
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
