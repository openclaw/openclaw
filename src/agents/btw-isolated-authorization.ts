import type { Model } from "../llm/types.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { resolveBtwPreparedRuntimeAuth } from "./btw-runtime.js";
import type { AgentHarness, AgentHarnessIsolatedCompletionAuthorization } from "./harness/types.js";
import { prepareIsolatedHostAuthorization } from "./isolated-completion-model-authority.js";
import { scopeAuthProfileStoreToPreparedPlan } from "./runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";

export function prepareBtwIsolatedAuthorization(params: {
  harness: AgentHarness;
  model: Model;
  resolvedAttempt:
    | Awaited<ReturnType<typeof resolveBtwPreparedRuntimeAuth>>
    | { model: Model; plan: AgentRuntimeAuthPlan };
  authProfileStore: AuthProfileStore;
}): AgentHarnessIsolatedCompletionAuthorization {
  const { harness, model, resolvedAttempt, authProfileStore } = params;
  return "auth" in resolvedAttempt
    ? prepareIsolatedHostAuthorization(harness, {
        owner: "host" as const,
        model,
        auth: resolvedAttempt.auth,
      })
    : {
        owner: "harness",
        plan: resolvedAttempt.plan,
        authProfileStore: scopeAuthProfileStoreToPreparedPlan(
          authProfileStore,
          resolvedAttempt.plan,
        ),
      };
}
