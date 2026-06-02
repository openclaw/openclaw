import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderTransformSystemPromptContext } from "../../../plugins/types.js";
import { buildEmbeddedSystemPrompt } from "../system-prompt.js";

type EmbeddedSystemPromptParams = Parameters<typeof buildEmbeddedSystemPrompt>[0];
type ProviderSystemPromptTransform = (params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  context: ProviderTransformSystemPromptContext;
}) => string;

/** Inputs needed to build the base prompt and provider-specific final prompt. */
export type BuildAttemptSystemPromptParams = {
  isRawModelRun: boolean;
  embeddedSystemPrompt: EmbeddedSystemPromptParams;
  transformProviderSystemPrompt: ProviderSystemPromptTransform;
  providerTransform: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir: string;
    context: Omit<ProviderTransformSystemPromptContext, "systemPrompt">;
  };
};

/** Base prompt before provider transforms, plus the prompt submitted to the model. */
export type AttemptSystemPrompt = {
  baseSystemPrompt: string;
  systemPrompt: string;
};

/** Builds an attempt system prompt while preserving raw model probes as prompt-free. */
export function buildAttemptSystemPrompt(
  params: BuildAttemptSystemPromptParams,
): AttemptSystemPrompt {
  const baseSystemPrompt = buildEmbeddedSystemPrompt(params.embeddedSystemPrompt);
  // Raw model probes measure the user prompt against the provider directly;
  // still return baseSystemPrompt so callers can inspect what was skipped.
  const systemPrompt = params.isRawModelRun
    ? ""
    : params.transformProviderSystemPrompt({
        provider: params.providerTransform.provider,
        config: params.providerTransform.config,
        workspaceDir: params.providerTransform.workspaceDir,
        context: {
          ...params.providerTransform.context,
          systemPrompt: baseSystemPrompt,
        },
      });

  return {
    baseSystemPrompt,
    systemPrompt,
  };
}
