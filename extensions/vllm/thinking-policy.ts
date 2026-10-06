import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-metadata";

export type VllmQwenThinkingFormat = "chat-template" | "top-level";

const VLLM_BINARY_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low", label: "on" }],
  defaultLevel: "off",
} satisfies ProviderThinkingProfile;

export function resolveVllmQwenThinkingFormatFromCompat(
  compat?: ProviderDefaultThinkingPolicyContext["compat"],
): VllmQwenThinkingFormat | undefined {
  // Doctor migrates legacy spellings before runtime consumes the canonical config.
  switch (compat?.thinkingFormat) {
    case "qwen-chat-template":
      return "chat-template";
    case "qwen":
      return "top-level";
    default:
      return undefined;
  }
}

export function isVllmNemotronThinkingModel(modelId: string): boolean {
  return /\bnemotron-3(?:[-_](?:nano|super|ultra))?\b/i.test(modelId);
}

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | null {
  if (normalizeProviderId(ctx.provider) !== "vllm" || ctx.reasoning === false) {
    return null;
  }
  const qwenFormat = resolveVllmQwenThinkingFormatFromCompat(ctx.compat);
  if (qwenFormat || (ctx.reasoning === true && isVllmNemotronThinkingModel(ctx.modelId))) {
    return VLLM_BINARY_THINKING_PROFILE;
  }
  return null;
}
