import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderTransformSystemPromptContext } from "../../../plugins/types.js";
import { appendAgentBootstrapSystemPromptSupplement } from "../../system-prompt.js";
import { buildEmbeddedSystemPrompt, createSystemPromptOverride } from "../system-prompt.js";

type EmbeddedSystemPromptParams = Parameters<typeof buildEmbeddedSystemPrompt>[0];
type ProviderSystemPromptTransform = (params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  context: ProviderTransformSystemPromptContext;
}) => string;

export type BuildAttemptSystemPromptParams = {
  isRawModelRun: boolean;
  systemPromptOverrideText?: string;
  embeddedSystemPrompt: EmbeddedSystemPromptParams;
  transformProviderSystemPrompt: ProviderSystemPromptTransform;
  providerTransform: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir: string;
    context: Omit<ProviderTransformSystemPromptContext, "systemPrompt">;
  };
};

export type AttemptSystemPrompt = {
  baseSystemPrompt: string;
  systemPrompt: string;
  systemPromptOverride: (defaultPrompt?: string) => string;
};

export function buildAttemptSystemPrompt(
  params: BuildAttemptSystemPromptParams,
): AttemptSystemPrompt {
  const baseSystemPrompt = params.systemPromptOverrideText
    ? appendExtraSystemPromptForOverride(
        appendAgentBootstrapSystemPromptSupplement({
          systemPrompt: params.systemPromptOverrideText,
          bootstrapMode: params.embeddedSystemPrompt.bootstrapMode,
          bootstrapTruncationNotice: params.embeddedSystemPrompt.bootstrapTruncationNotice,
          contextFiles: params.embeddedSystemPrompt.contextFiles,
        }),
        params.embeddedSystemPrompt,
      )
    : buildEmbeddedSystemPrompt(params.embeddedSystemPrompt);

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
    systemPromptOverride: createSystemPromptOverride(systemPrompt),
  };
}

/**
 * Mirrors the `extraSystemPrompt` rendering in `buildAgentSystemPrompt` so that
 * runtime-provided `extraSystemPrompt` content (e.g. the subagent task block
 * built by `buildSubagentSystemPrompt`) is preserved when an agent uses
 * `systemPromptOverride`. Without this, sub-agents whose target agent has a
 * `systemPromptOverride` lose the assigned task because the override branch
 * skipped `buildEmbeddedSystemPrompt`, which is the only place that renders
 * `extraSystemPrompt`.
 */
function appendExtraSystemPromptForOverride(
  basePrompt: string,
  embedded: EmbeddedSystemPromptParams,
): string {
  const extra = embedded.extraSystemPrompt?.trim();
  if (!extra) {
    return basePrompt;
  }
  const contextHeader =
    embedded.promptMode === "minimal" ? "## Subagent Context" : "## Group Chat Context";
  return `${basePrompt.trimEnd()}\n\n${contextHeader}\n${extra}\n`;
}
