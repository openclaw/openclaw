import type { AuthProfileAuthorization } from "../../auth-profiles/authorization-contract.js";
import { assertSettledAuthProfileAuthorization } from "../../auth-profiles/authorization-settle.js";
import { hasOAuthIdentity, isSafeToCopyOAuthIdentity } from "../../auth-profiles/oauth-identity.js";
import { getApiKeyForModelCore } from "../../model-auth.js";
import type { createRuntimeAuthDeadline } from "../../runtime-auth-refresh.js";
import type { EmbeddedRunAuthControllerParams } from "./auth-controller.types.js";

/**
 * A sibling run can rotate a shared OAuth token after this attempt read it, and the provider then
 * rejects the held token. Re-read the canonical owner without forcing a refresh (the attempt's
 * captured store is omitted) and adopt it only when its token changed.
 */
export async function adoptRotatedOAuthCredential(input: {
  params: EmbeddedRunAuthControllerParams;
  state: EmbeddedRunAuthControllerParams["state"];
  withAuthDeadline: ReturnType<typeof createRuntimeAuthDeadline>["run"];
  /** The run's captured account lifetime; an explicit reconnect retires it. */
  authorization: AuthProfileAuthorization | undefined;
}): Promise<boolean> {
  const { params, state, authorization } = input;
  const held = state.apiKeyInfo;
  // Without a captured lifetime a replacement token cannot be bound to this run.
  if (held?.mode !== "oauth" || !authorization) {
    return false;
  }
  const profileId = held.profileId;
  const selected = profileId ? params.authStore.profiles[profileId] : undefined;
  if (!profileId || selected?.type !== "oauth") {
    return false;
  }
  const current = await input.withAuthDeadline("credential resolution", async (signal) => {
    const resolved = await getApiKeyForModelCore({
      model: state.models.runtime,
      cfg: params.config,
      profileId,
      lockedProfile: true,
      allowAuthProfileFallback: false,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      secretSentinels: true,
      signal,
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
    // A sibling refresh keeps this lifetime (wait for it to settle); a reconnect retires it.
    await assertSettledAuthProfileAuthorization(authorization.assertCurrent, signal);
    return resolved;
  });
  // Sentinels are stable per value, so equal strings mean the stored token is unchanged.
  if (
    current.profileId !== profileId ||
    current.mode !== "oauth" ||
    !current.apiKey ||
    current.apiKey === held.apiKey
  ) {
    return false;
  }
  params.authStorage.setRuntimeApiKey(state.models.runtime.provider, current.apiKey);
  state.apiKeyInfo = current;
  return true;
}
