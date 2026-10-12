import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { resolveOpenAIRequestReasoning, type Model } from "openclaw/plugin-sdk/llm";
import type {
  ProviderNormalizeResolvedModelContext,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-metadata";
import {
  composeProviderStreamWrappers,
  createPayloadPatchStreamWrapper,
  setQwenChatTemplateThinking,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  isVllmNemotronThinkingModel,
  resolveVllmEffortProfile,
  resolveVllmQwenThinkingFormatFromCompat,
  type VllmQwenThinkingFormat,
} from "./thinking-policy.js";

type VllmThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];

function isCompletionsModel(model: Model): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

function isVllmDeepSeekV4Model(modelId: string): boolean {
  return /deepseek[-_]?v4(?:[-_](?:pro|flash))?\b/i.test(modelId);
}

export function normalizeVllmResolvedModel({
  model,
}: ProviderNormalizeResolvedModelContext):
  | ProviderNormalizeResolvedModelContext["model"]
  | undefined {
  if (
    model.api !== "openai-completions" ||
    !model.reasoning ||
    !resolveVllmQwenThinkingFormatFromCompat(model.compat)
  ) {
    return undefined;
  }
  const profile = resolveVllmEffortProfile(model);
  if (!profile) {
    return undefined;
  }
  // Session setup clamps before stream wrappers run; prepare the same declared choices there.
  const thinkingLevelMap = { ...model.thinkingLevelMap };
  for (const { id } of profile.levels) {
    if (id === "off" || id === "adaptive" || id === "ultra") {
      continue;
    }
    const { effort } = resolveOpenAIRequestReasoning(model, id);
    if (effort !== undefined) {
      thinkingLevelMap[id] = effort;
    }
  }
  return { ...model, thinkingLevelMap };
}

function setChatTemplateDefaults(
  payload: Record<string, unknown>,
  defaults: Record<string, unknown>,
): void {
  const existing = payload.chat_template_kwargs;
  payload.chat_template_kwargs =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? {
          ...defaults,
          ...(existing as Record<string, unknown>),
        }
      : defaults;
}

export function createVllmQwenThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  format: VllmQwenThinkingFormat;
  thinkingLevel: VllmThinkingLevel;
}): StreamFn {
  return createPayloadPatchStreamWrapper(
    params.baseStreamFn,
    ({ payload: payloadObj, model, options }) => {
      if (!isCompletionsModel(model) || !(model.reasoning ?? true)) {
        return;
      }
      const reasoning = resolveOpenAIRequestReasoning(
        { ...model, reasoning: model.reasoning ?? true },
        options?.reasoning ?? params.thinkingLevel,
      );
      const enableThinking = reasoning.thinkingEnabled ?? true;
      const effort =
        enableThinking && resolveVllmEffortProfile(model) ? reasoning.effort : undefined;
      delete payloadObj.reasoning_effort;
      if (params.format === "chat-template") {
        const kwargs = setQwenChatTemplateThinking(payloadObj, enableThinking);
        if (effort !== undefined) {
          kwargs.reasoning_effort = effort;
        }
      } else {
        payloadObj.enable_thinking = enableThinking;
        if (effort !== undefined) {
          payloadObj.reasoning_effort = effort;
        }
      }
      delete payloadObj.reasoningEffort;
      delete payloadObj.reasoning;
    },
  );
}

export function wrapVllmProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (
    normalizeProviderId(ctx.provider) !== "vllm" ||
    (ctx.model && ctx.model.api !== "openai-completions")
  ) {
    return undefined;
  }
  const qwenFormat = resolveVllmQwenThinkingFormatFromCompat(ctx.model?.compat);
  const deepSeek = !qwenFormat && isVllmDeepSeekV4Model(ctx.modelId);
  if (!qwenFormat && !deepSeek && !isVllmNemotronThinkingModel(ctx.modelId)) {
    return undefined;
  }
  return composeProviderStreamWrappers(
    ctx.streamFn,
    qwenFormat &&
      ((streamFn) =>
        createVllmQwenThinkingWrapper({
          baseStreamFn: streamFn,
          format: qwenFormat,
          thinkingLevel: ctx.thinkingLevel,
        })),
    (streamFn) =>
      createPayloadPatchStreamWrapper(streamFn, ({ payload, model, options }) => {
        if (!isCompletionsModel(model) || normalizeProviderId(model.provider) !== "vllm") {
          return;
        }
        const level = options?.reasoning ?? ctx.thinkingLevel;
        if (
          model.reasoning &&
          isVllmDeepSeekV4Model(model.id) &&
          !resolveVllmQwenThinkingFormatFromCompat(model.compat)
        ) {
          const reasoning = resolveOpenAIRequestReasoning(model, level);
          const enabled = reasoning.thinkingEnabled ?? true;
          // vLLM enables DeepSeek if either template flag is true.
          setChatTemplateDefaults(payload, {
            thinking: enabled,
            enable_thinking: enabled,
            ...(enabled && reasoning.effort ? { reasoning_effort: reasoning.effort } : {}),
          });
          delete payload.thinking;
          delete payload.reasoning_effort;
          delete payload.reasoning;
        } else if (level === "off" && isVllmNemotronThinkingModel(model.id)) {
          setChatTemplateDefaults(payload, {
            enable_thinking: false,
            force_nonempty_content: true,
          });
        }
      }),
  );
}
