// Qa Lab plugin entrypoint registers its OpenClaw integration.
import type { QaProviderDefinition } from "../shared/types.js";

function isOpenAiModel(modelRef: string) {
  return modelRef.startsWith("openai/");
}

// claude-cli is an Anthropic-backed Claude runtime, so it shares the Anthropic
// turn-timeout floors; mirror the claude-cli==anthropic precedent in the aimock
// and mock-openai servers.
function isAnthropicFamilyModel(modelRef: string) {
  return modelRef.startsWith("anthropic/") || modelRef.startsWith("claude-cli/");
}

function isGptFiveModel(modelRef: string) {
  return isOpenAiModel(modelRef) && modelRef.slice("openai/".length).startsWith("gpt-5");
}

function isClaudeOpusModel(modelRef: string) {
  return isAnthropicFamilyModel(modelRef) && modelRef.includes("claude-opus");
}

export const liveFrontierProviderDefinition: QaProviderDefinition = {
  mode: "live-frontier",
  kind: "live",
  defaultModel: (options) => options?.preferredLiveModel ?? "openai/gpt-5.6-luna",
  defaultImageGenerationProviderIds: ["openai"],
  defaultImageGenerationModel: ({ modelProviderIds }) =>
    modelProviderIds.includes("openai") ? "openai/gpt-image-1" : null,
  usesFastModeByDefault: isOpenAiModel,
  resolveModelParams: ({ modelRef, fastMode, thinkingDefault }) => ({
    transport: "sse",
    openaiWsWarmup: false,
    ...((fastMode ?? isOpenAiModel(modelRef)) ? { fastMode: true } : {}),
    ...(thinkingDefault ? { thinking: thinkingDefault } : {}),
  }),
  resolveTurnTimeoutMs: ({ fallbackMs, modelRef }) => {
    if (isClaudeOpusModel(modelRef)) {
      return Math.max(fallbackMs, 240_000);
    }
    if (isAnthropicFamilyModel(modelRef)) {
      return Math.max(fallbackMs, 180_000);
    }
    if (isGptFiveModel(modelRef)) {
      return Math.max(fallbackMs, 360_000);
    }
    return Math.max(fallbackMs, 120_000);
  },
  buildGatewayModels: ({ liveProviderConfigs }) => {
    const providers = liveProviderConfigs ?? {};
    return Object.keys(providers).length > 0
      ? {
          mode: "merge",
          providers,
        }
      : null;
  },
  usesModelProviderPlugins: true,
  scrubsLiveProviderEnv: false,
  appliesLiveEnvAliases: true,
};
