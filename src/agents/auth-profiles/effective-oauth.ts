/**
 * Effective OAuth credential resolver.
 * Delegates to the managed OAuth selector while allowing external CLI
 * bootstrap credentials to fill unusable local profile state.
 */
<<<<<<< HEAD
import { readExternalCliBootstrapCredential } from "./external-cli-sync.js";
=======
import { readManagedExternalCliCredential } from "./external-cli-sync.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import { resolveEffectiveOAuthCredential as resolveManagedOAuthCredential } from "./oauth-manager.js";
import type { OAuthCredential } from "./types.js";

/** Resolves the effective OAuth credential, optionally reading external CLI bootstrap state. */
export function resolveEffectiveOAuthCredential(params: {
  profileId: string;
  credential: OAuthCredential;
  allowKeychainPrompt?: boolean;
}): OAuthCredential {
  return resolveManagedOAuthCredential({
    profileId: params.profileId,
    credential: params.credential,
    readBootstrapCredential: ({ profileId, credential }) =>
<<<<<<< HEAD
      readExternalCliBootstrapCredential({
=======
      readManagedExternalCliCredential({
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
        profileId,
        credential,
        allowKeychainPrompt: params.allowKeychainPrompt ?? false,
      }),
  });
}
