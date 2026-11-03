import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";

const RESPONSES_FAMILY_APIS = new Set([
  "openai-responses",
  "openai-chatgpt-responses",
  "azure-openai-responses",
]);

type ReplayPolicyBuilder = (ctx: ProviderReplayPolicyContext) => ProviderReplayPolicy | undefined;

/**
 * Keeps the per-turn runtime context in place for Responses endpoints.
 *
 * xAI's prefix cache only reuses a turn when the previous request is a prefix of the next one.
 * Removing the previous turn's runtime-context carrier on every new user turn breaks that, so
 * the first call of each turn missed the cache while in-turn tool follow-ups hit it.
 */
export function buildXaiReplayPolicy(base: ReplayPolicyBuilder | undefined): ReplayPolicyBuilder {
  return (ctx) => {
    const policy = base?.(ctx);
    if (!policy || !RESPONSES_FAMILY_APIS.has(ctx.modelApi ?? "")) {
      return policy;
    }
    return { ...policy, appendOnlyRuntimeContext: true };
  };
}
