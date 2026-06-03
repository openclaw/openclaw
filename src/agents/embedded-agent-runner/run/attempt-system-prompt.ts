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

/**
 * Inputs for building the embedded-attempt system prompt. The base embedded
 * prompt is always built for diagnostics, while provider transforms are skipped
 * for raw model probes.
 */
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

/** Base prompt plus the provider-facing prompt after optional transformation. */
export type AttemptSystemPrompt = {
  baseSystemPrompt: string;
  systemPrompt: string;
};

/**
 * Builds both the canonical embedded prompt and the provider-facing prompt.
 * Raw model runs intentionally return an empty provider prompt while preserving
 * baseSystemPrompt so callers can still inspect what would have been built.
 */
export function buildAttemptSystemPrompt(
  params: BuildAttemptSystemPromptParams,
): AttemptSystemPrompt {
  const baseSystemPrompt = buildEmbeddedSystemPrompt(params.embeddedSystemPrompt);
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
