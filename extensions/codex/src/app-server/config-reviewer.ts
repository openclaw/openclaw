import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/agent-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/model-ref-parse";
import { resolveProviderIdForAuthAsync } from "openclaw/plugin-sdk/provider-auth-aliases";
import type { CodexModelBackedReviewerContext } from "./config-contracts.js";
import { canUseCodexModelBackedApprovalsReviewerForModel as canUseModelBackedReviewer } from "./config-reviewer-policy.js";

export {
  assertCodexModelBackedReviewerEffectiveConfig,
  resolveCodexModelBackedReviewerPolicyContext,
} from "./config-reviewer-policy.js";

export function canUseCodexModelBackedApprovalsReviewerForModel(
  params: CodexModelBackedReviewerContext,
): boolean {
  return canUseModelBackedReviewer(params, resolveProviderIdForAuth);
}

/** Capture the aliases used by this configuration before synchronous policy selection. */
export async function prepareCodexAuthProviderResolver(
  params: Pick<CodexModelBackedReviewerContext, "config" | "env">,
): Promise<typeof resolveProviderIdForAuth> {
  const aliases = new Map(
    await Promise.all(
      Object.keys(params.config?.models?.providers ?? {}).map(
        async (provider) =>
          [
            provider,
            await resolveProviderIdForAuthAsync(provider, {
              config: params.config,
              env: params.env,
            }),
          ] as const,
      ),
    ),
  );
  return (provider) => aliases.get(provider) ?? normalizeProviderId(provider);
}
