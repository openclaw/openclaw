import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { calculateCost, streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  transformProviderStreamMessages,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isFireworksKimiModelId } from "./model-id.js";
import { isFireworksNativeModel } from "./provider-catalog.js";

function isFireworksProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return normalized === "fireworks" || normalized === "fireworks-ai";
}

export function wrapFireworksProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  if (
    !isFireworksProviderId(ctx.provider) ||
    (ctx.sourceApi ?? ctx.model?.api) !== "openai-completions"
  ) {
    return undefined;
  }
  const isKimi = isFireworksKimiModelId(ctx.modelId);
  const isNative = isFireworksNativeModel(ctx.model, ctx.sourceApi);
  if (!isKimi && !isNative) {
    return undefined;
  }
  const underlying = isKimi
    ? createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload }) => {
        // Fireworks Kimi can emit chain-of-thought in visible `content` unless
        // the Anthropic-style thinking toggle is explicitly disabled.
        payload.thinking = { type: "disabled" };
        delete payload.reasoning;
        delete payload.reasoning_effort;
        delete payload.reasoningEffort;
      })
    : (ctx.streamFn ?? streamSimple);
  if (!isNative) {
    return underlying;
  }
  return async (model, context, options) => {
    let cache: { prompt: number; read: number } | undefined;
    const stream = await underlying(model, context, {
      ...options,
      onResponse(response, responseModel) {
        const prompt = Number(response.headers["fireworks-prompt-tokens"]?.trim() || Number.NaN);
        const read = Number(
          response.headers["fireworks-cached-prompt-tokens"]?.trim() || Number.NaN,
        );
        cache =
          Number.isSafeInteger(prompt) && Number.isSafeInteger(read) && read >= 0 && read <= prompt
            ? { prompt, read }
            : undefined;
        return options?.onResponse?.(response, responseModel);
      },
    });
    return transformProviderStreamMessages(stream, (message) => {
      const usage = message.usage;
      if (
        !cache ||
        usage.cacheTelemetry?.state !== "unavailable" ||
        usage.input + usage.cacheRead + usage.cacheWrite !== cache.prompt
      ) {
        return;
      }
      usage.input -= cache.read;
      usage.cacheRead = cache.read;
      usage.cacheTelemetry = { state: "available" };
      const billedTotal = usage.cost.total;
      calculateCost(model, usage);
      if (usage.cost.totalOrigin === "provider-billed") {
        usage.cost.total = billedTotal;
      }
    });
  };
}
