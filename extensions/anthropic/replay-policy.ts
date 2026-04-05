import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
} from "mullusi/plugin-sdk/plugin-entry";
import { buildAnthropicReplayPolicyForModel } from "mullusi/plugin-sdk/provider-model-shared";

/**
 * Returns the provider-owned replay policy for Anthropic transports.
 */
export function buildAnthropicReplayPolicy(ctx: ProviderReplayPolicyContext): ProviderReplayPolicy {
  return buildAnthropicReplayPolicyForModel(ctx.modelId);
}
