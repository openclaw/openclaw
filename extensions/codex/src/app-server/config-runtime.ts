import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/agent-runtime";
import type { CodexModelBackedReviewerContext } from "./config-contracts.js";
import { createCodexAppServerConfig } from "./config-options.js";
import { canUseCodexModelBackedApprovalsReviewerForModel } from "./config-reviewer-policy.js";
import { prepareCodexAuthProviderResolver } from "./config-reviewer.js";

// Synchronous defaults do not select model aliases; supplied-model callers prepare below.
export const {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexSupervisionAppServerRuntimeOptions,
} = createCodexAppServerConfig({ resolveProviderIdForAuth });

export {
  codexAppServerStartOptionsKey,
  codexSandboxPolicyForTurn,
  resolveCodexAppServerHomeScope,
  resolveCodexAppServerStartOptionsForAgent,
  resolveCodexComputerUseConfig,
} from "./config-options.js";

/** Prepare one provider selection for runtime options and the matching reviewer decision. */
export async function prepareCodexAppServerConfig(
  params: Pick<CodexModelBackedReviewerContext, "config" | "env">,
) {
  const resolveAuthProviderId = await prepareCodexAuthProviderResolver(params);
  return {
    ...createCodexAppServerConfig({ resolveProviderIdForAuth: resolveAuthProviderId }),
    canUseCodexModelBackedApprovalsReviewerForModel: (
      context: Omit<CodexModelBackedReviewerContext, "config" | "env">,
    ) =>
      canUseCodexModelBackedApprovalsReviewerForModel(
        { ...context, ...params },
        resolveAuthProviderId,
      ),
  };
}
