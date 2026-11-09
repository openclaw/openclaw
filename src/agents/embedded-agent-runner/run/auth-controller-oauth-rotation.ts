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
}): Promise<boolean> {
  const { params, state } = input;
  const held = state.apiKeyInfo;
  if (held?.mode !== "oauth") {
    return false;
  }
  const profileId = held.profileId;
  const selected = profileId ? params.authStore.profiles[profileId] : undefined;
  if (!profileId || selected?.type !== "oauth") {
    return false;
  }
  const current = await input.withAuthDeadline("credential resolution", (signal) =>
    getApiKeyForModelCore({
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
    }),
  );
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
