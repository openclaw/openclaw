import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  isOpenAICompatibleThinkingEnabled,
} from "openclaw/plugin-sdk/provider-stream-shared";

type QwenThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];

function isQwenProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return (
    normalized === "qwen" ||
    normalized === "modelstudio" ||
    normalized === "qwencloud" ||
    normalized === "dashscope"
  );
}

export function createQwenThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: QwenThinkingLevel,
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload: payloadObj, model, options }) => {
      const enableThinking = isOpenAICompatibleThinkingEnabled({ thinkingLevel, options });
      payloadObj.enable_thinking = enableThinking;
      delete payloadObj.reasoning_effort;
      delete payloadObj.reasoningEffort;
      delete payloadObj.reasoning;
      // Qwen 3.6 served via llama.cpp honors chat_template_kwargs.enable_thinking
      // and ignores the top-level enable_thinking field. The transport's
      // qwen-chat-template formatter resolves enable_thinking from request
      // options only, so when the session thinking level is the source of truth
      // (e.g. /think off without an explicit reasoning override) the wrong value
      // is sent. Mirror the top-level decision into chat_template_kwargs so the
      // session thinking control wins.
      if (hasQwenChatTemplateThinkingFormat(model)) {
        setQwenChatTemplateThinkingEnabled(payloadObj, enableThinking);
      }
    },
    {
      shouldPatch: ({ model }) => model.api === "openai-completions" && model.reasoning,
    },
  );
}

function hasQwenChatTemplateThinkingFormat(model: Parameters<StreamFn>[0]): boolean {
  const compat = (model as { compat?: { thinkingFormat?: unknown } }).compat;
  return compat?.thinkingFormat === "qwen-chat-template";
}

function setQwenChatTemplateThinkingEnabled(
  payload: Record<string, unknown>,
  enabled: boolean,
): void {
  const existing = payload.chat_template_kwargs;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    (existing as Record<string, unknown>).enable_thinking = enabled;
    return;
  }
  payload.chat_template_kwargs = { enable_thinking: enabled };
}

export function wrapQwenProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (!isQwenProviderId(ctx.provider) || (ctx.model && ctx.model.api !== "openai-completions")) {
    return undefined;
  }
  return createQwenThinkingWrapper(ctx.streamFn, ctx.thinkingLevel);
}
