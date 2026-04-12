import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";

const OPENROUTER_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("openrouter-thinking");

/**
 * Injects the OpenRouter auto-router plugin into the request payload,
 * constraining model selection to the provided allowlist.
 *
 * Config example:
 * ```json
 * {
 *   "model": "openrouter/openrouter/auto",
 *   "params": {
 *     "autoRouter": { "allowedModels": ["anthropic/claude-haiku-4-5", "google/gemini-2.5-flash"] }
 *   }
 * }
 * ```
 */
export function injectAutoRouterPlugin(
  baseStreamFn: StreamFn | undefined,
  allowedModels: string[],
): StreamFn {
  const underlying =
    baseStreamFn ??
    ((nextModel: { id?: unknown }) => {
      throw new Error(
        `OpenRouter auto-router wrapper requires an underlying streamFn for ${String(nextModel.id)}.`,
      );
    });
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return (underlying as StreamFn)(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const existing = Array.isArray((payload as Record<string, unknown>).plugins)
            ? ((payload as Record<string, unknown>).plugins as unknown[])
            : [];
          (payload as Record<string, unknown>).plugins = [
            ...existing,
            { id: "auto-router", allowed_models: allowedModels },
          ];
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

/**
 * Returns true if the pattern is or contains an x-ai model reference, including wildcards
 * such as `x-ai/*`. Note: provider-agnostic wildcards like `*\/grok-*` cannot be detected
 * without a model registry lookup and are not handled here.
 */
function patternMightBeProxyReasoningUnsupported(pattern: string): boolean {
  const lower = pattern.trim().toLowerCase();
  return lower.startsWith("x-ai/") || lower.includes("/x-ai/");
}

function injectOpenRouterRouting(
  baseStreamFn: StreamFn | undefined,
  providerRouting?: Record<string, unknown>,
): StreamFn | undefined {
  if (!providerRouting) {
    return baseStreamFn;
  }
  return (model, context, options) =>
    (
      baseStreamFn ??
      ((nextModel) => {
        throw new Error(
          `OpenRouter routing wrapper requires an underlying streamFn for ${nextModel.id}.`,
        );
      })
    )(
      {
        ...model,
        compat: { ...model.compat, openRouterRouting: providerRouting },
      } as typeof model,
      context,
      options,
    );
}

export function wrapOpenRouterProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | null | undefined {
  const providerRouting =
    ctx.extraParams?.provider != null && typeof ctx.extraParams.provider === "object"
      ? (ctx.extraParams.provider as Record<string, unknown>)
      : undefined;
  let streamFn = providerRouting
    ? injectOpenRouterRouting(ctx.streamFn, providerRouting)
    : ctx.streamFn;

  let autoRouterAllowedModels: string[] = [];
  const autoRouterConfig = ctx.extraParams?.autoRouter;
  if (autoRouterConfig != null && typeof autoRouterConfig === "object") {
    const rawAllowedModels = (autoRouterConfig as Record<string, unknown>).allowedModels;
    if (Array.isArray(rawAllowedModels) && rawAllowedModels.length > 0) {
      const validModels = rawAllowedModels.filter((m): m is string => typeof m === "string");
      if (validModels.length > 0) {
        autoRouterAllowedModels = validModels;
        streamFn = injectAutoRouterPlugin(streamFn, autoRouterAllowedModels);
      }
    }
  }

  const allowlistBlocksReasoning = autoRouterAllowedModels.some(
    patternMightBeProxyReasoningUnsupported,
  );
  if (allowlistBlocksReasoning && ctx.thinkingLevel && ctx.thinkingLevel !== "off") {
    console.warn(
      `openrouter: reasoning injection suppressed because autoRouter.allowedModels contains x-ai models that do not support proxy reasoning (thinkingLevel=${ctx.thinkingLevel}). Remove x-ai models from the allowlist to enable reasoning.`,
    );
  }

  const wrapStreamFn = OPENROUTER_THINKING_STREAM_HOOKS.wrapStreamFn ?? undefined;
  if (!wrapStreamFn) {
    return streamFn;
  }
  return (
    wrapStreamFn({
      ...ctx,
      streamFn,
      thinkingLevel: allowlistBlocksReasoning ? undefined : ctx.thinkingLevel,
    }) ?? undefined
  );
}
