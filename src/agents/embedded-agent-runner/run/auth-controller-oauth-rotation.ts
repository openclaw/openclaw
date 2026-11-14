import type { Model } from "../../../llm/types.js";
import type { AuthProfileAuthorization } from "../../auth-profiles/authorization-contract.js";
import { assertSettledAuthProfileAuthorization } from "../../auth-profiles/authorization-settle.js";
import { hasOAuthIdentity, isSafeToCopyOAuthIdentity } from "../../auth-profiles/oauth-identity.js";
import { getApiKeyForModelCore, type ResolvedProviderAuth } from "../../model-auth.js";
import type { createRuntimeAuthDeadline } from "../../runtime-auth-refresh.js";
import type { EmbeddedRunAuthControllerParams } from "./auth-controller.types.js";

/** Re-read the canonical OAuth owner under the run's captured account lifetime. */
export async function resolveCanonicalOAuthCredential(input: {
  params: EmbeddedRunAuthControllerParams;
  model: Model;
  profileId: string | undefined;
  withAuthDeadline: ReturnType<typeof createRuntimeAuthDeadline>["run"];
  signal?: AbortSignal;
  secretSentinels?: boolean;
  /** An explicit reconnect retires this lifetime; a sibling refresh preserves it. */
  authorization: AuthProfileAuthorization | undefined;
}): Promise<ResolvedProviderAuth | undefined> {
  const { params, authorization, profileId } = input;
  const selected = profileId ? params.authStore.profiles[profileId] : undefined;
  if (!authorization || !profileId || selected?.type !== "oauth") {
    return undefined;
  }
  const current = await input.withAuthDeadline(
    "credential resolution",
    async (signal) => {
      const assertCurrent = () => {
        signal.throwIfAborted();
        authorization.assertCurrent();
      };
      await assertSettledAuthProfileAuthorization(assertCurrent, signal);
      while (true) {
        // Omit the attempt's captured store. Canonical resolution owns refresh/rotation.
        const resolved = await getApiKeyForModelCore({
          model: input.model,
          cfg: params.config,
          profileId,
          lockedProfile: true,
          allowAuthProfileFallback: false,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          secretSentinels: input.secretSentinels,
          signal,
          assertRefreshAdmission: assertCurrent,
          validateOAuthCredential: (credential) => {
            if (
              credential.provider !== selected.provider ||
              credential.authFlow !== selected.authFlow ||
              !isSafeToCopyOAuthIdentity(selected, credential) ||
              (!hasOAuthIdentity(selected) && credential.refresh !== selected.refresh)
            ) {
              throw new Error("Provider credentials changed account identity.");
            }
          },
        });
        // A peer publication can begin during lookup. Read its settled token again.
        if (!(await assertSettledAuthProfileAuthorization(assertCurrent, signal))) {
          return resolved;
        }
      }
    },
    input.signal,
  );
  if (current.profileId !== profileId || current.mode !== "oauth" || !current.apiKey) {
    return undefined;
  }
  return current;
}
