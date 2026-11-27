import type { Model } from "@openclaw/llm-core";
import { getAiTransportHost, type OpenAIStrictToolRoute } from "../host.js";
import { isNativeOpenAIEndpoint } from "./openai-completions-compat.js";

// A route that declares compat.supportsStrictMode (config or provider catalog) is never second-guessed.
function declaresStrictMode(model: Model): boolean {
  return (
    (model.compat as { supportsStrictMode?: unknown } | undefined)?.supportsStrictMode !== undefined
  );
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
  // Native OpenAI serves strict tools, so it never reads the learned record.
  if (declaresStrictMode(model) || !rejections || isNativeOpenAIEndpoint(model)) {
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
  const status = (error as { status?: unknown } | null)?.status;
  return (
    (status === 400 || status === 422) &&
    !declaresStrictMode(model) &&
    (tools ?? []).some((tool) => {
      const record = tool as { strict?: unknown; function?: { strict?: unknown } };
      return record.strict === true || record.function?.strict === true;
    })
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
