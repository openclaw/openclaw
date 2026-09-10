import { resolveOpenRouterThinkingProfile } from "./thinking-policy.js";

/** OpenRouter meters and rate-limits upstream; OpenClaw skips its auth-profile cooldowns. */
export const managesOwnAvailability = true;

export function resolveThinkingProfile(params: { provider?: string; modelId: string }) {
  return resolveOpenRouterThinkingProfile(params.modelId);
}
