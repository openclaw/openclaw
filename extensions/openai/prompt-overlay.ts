import {
  isGpt5ModelId,
  resolveGpt5PromptOverlayMode,
  resolveGpt5SystemPromptContribution,
} from "openclaw/plugin-sdk/provider-model-metadata";
import type { Gpt5PromptOverlayMode } from "openclaw/plugin-sdk/provider-model-shared";

export function resolveOpenAIPromptOverlayMode(
  pluginConfig?: Record<string, unknown>,
): Gpt5PromptOverlayMode {
  return resolveGpt5PromptOverlayMode(undefined, pluginConfig);
}

export function resolveOpenAISystemPromptContribution(params: {
  config?: Parameters<typeof resolveGpt5SystemPromptContribution>[0]["config"];
  legacyPluginConfig?: Record<string, unknown>;
  mode?: Gpt5PromptOverlayMode;
  modelProviderId?: string;
  modelId?: string;
  trigger?: Parameters<typeof resolveGpt5SystemPromptContribution>[0]["trigger"];
}) {
  return resolveGpt5SystemPromptContribution({
    config: params.config,
    legacyPluginConfig:
      params.mode === undefined ? params.legacyPluginConfig : { personality: params.mode },
    modelId: params.modelId,
    trigger: params.trigger,
    enabled: params.modelProviderId === "openai" && isGpt5ModelId(params.modelId),
  });
}
