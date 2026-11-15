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

export const liveFrontierProviderDefinition: QaProviderDefinition = {
  mode: "live-frontier",
  kind: "live",
  defaultModel: (options) => options?.preferredLiveModel ?? "openai/gpt-5.6-luna",
  usesFastModeByDefault: isOpenAiModel,
  resolveModelParams: ({ modelRef, fastMode, thinkingDefault }) => ({
    transport: "sse",
    openaiWsWarmup: false,
    ...((fastMode ?? isOpenAiModel(modelRef)) ? { fastMode: true } : {}),
    ...(thinkingDefault ? { thinking: thinkingDefault } : {}),
  }),
  resolveTurnTimeoutMs: ({ fallbackMs, modelRef }) => {
    if (isAnthropicFamilyModel(modelRef)) {
      return Math.max(fallbackMs, modelRef.includes("claude-opus") ? 240_000 : 180_000);
    }
    return Math.max(fallbackMs, modelRef.startsWith("openai/gpt-5") ? 360_000 : 120_000);
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
};
