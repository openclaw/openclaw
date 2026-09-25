// Codex transport selection for OpenAI models: which requests get the Codex
// responses hooks, and which models may be projected onto that transport.
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { isOpenAICodexBaseUrl } from "./base-url.js";
import {
  isOpenAIChatGPTModernModelId,
  isOpenAIPlatformOnlyRouteModelId,
  isOpenAIProviderModernModelId,
  isOpenAISubscriptionOnlyRouteModelId,
} from "./model-route-contract.js";

export function shouldUseCodexResponsesHooks(params: {
  provider?: string;
  api?: ProviderRuntimeModel["api"] | null;
  baseUrl?: string;
}): boolean {
  if (params.api === "openai-chatgpt-responses") {
    return true;
  }
  return typeof params.baseUrl === "string" && isOpenAICodexBaseUrl(params.baseUrl);
}

export function shouldResolveDynamicModelThroughCodex(
  ctx: ProviderResolveDynamicModelContext,
): boolean {
  if (
    shouldUseCodexResponsesHooks({
      provider: ctx.provider,
      api: ctx.providerConfig?.api,
      baseUrl: ctx.providerConfig?.baseUrl,
    })
  ) {
    return true;
  }
  if (
    ctx.providerConfig?.api === "openai-responses" ||
    ctx.providerConfig?.api === "openai-completions" ||
    (ctx.providerConfig?.baseUrl && !isOpenAICodexBaseUrl(ctx.providerConfig.baseUrl))
  ) {
    return false;
  }
  // The auth planner owns profile ordering and projects the selected physical
  // route into providerConfig before materialization. Until then, only a
  // one-route model contract may choose a transport.
  if (isOpenAIPlatformOnlyRouteModelId(ctx.modelId)) {
    return false;
  }
  if (isOpenAISubscriptionOnlyRouteModelId(ctx.modelId)) {
    return true;
  }
  // A first-party id the ChatGPT catalog does not list (gpt-5.4-nano) has no
  // subscription route to project onto; under the codex runtime it would
  // otherwise become ChatGPT-only and reject the operator's API key.
  if (isOpenAIProviderModernModelId(ctx.modelId) && !isOpenAIChatGPTModernModelId(ctx.modelId)) {
    return false;
  }
  return ctx.agentRuntimeId === "codex";
}
