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

/**
 * True when a request that was refused before any output may be retried once without
 * strict tools: a 400 or 422 on an undeclared route whose request carried a strict tool.
 */
export function isStrictToolRetryCandidate(
  model: Model,
  tools: readonly unknown[] | undefined,
  error: unknown,
): boolean {
  const status = isRecord(error) ? error.status : undefined;
  return (
    (status === 400 || status === 422) &&
    !declaresStrictMode(model) &&
    (tools ?? []).some(
      (tool) =>
        isRecord(tool) &&
        (tool.strict === true || (isRecord(tool.function) && tool.function.strict === true)),
    )
  );
}

/**
 * The retry without strict tools was accepted, so the route rejects them: remember it and
 * warn once. Only an accepted retry counts; an unrelated 400 fails the retry too.
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
