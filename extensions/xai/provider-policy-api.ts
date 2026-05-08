import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";

const XAI_FULL_REASONING_THINKING_PROFILE: ProviderThinkingProfile = {
  levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
  defaultLevel: "low",
};

const XAI_NON_REASONING_THINKING_PROFILE: ProviderThinkingProfile = {
  levels: [{ id: "off" }],
  defaultLevel: "off",
};

export function resolveThinkingProfile(
  params: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | undefined {
  if (params.provider.trim().toLowerCase() !== "xai") {
    return undefined;
  }

  if (params.reasoning) {
    return XAI_FULL_REASONING_THINKING_PROFILE;
  }

  return XAI_NON_REASONING_THINKING_PROFILE;
}
