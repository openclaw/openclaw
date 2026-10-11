import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { authProfilesLog } from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { readExternalCliBootstrapCredential } from "./external-cli-sync.js";
import {
  isSafeToAdoptBootstrapOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
} from "./oauth-shared.js";
import type { OAuthCredential } from "./types.js";

export type OAuthBootstrapCredentialReader = (params: {
  profileId: string;
  credential: OAuthCredential;
}) => OAuthCredential | null;

/** Select local OAuth unless a safe external bootstrap credential should win. */
export function resolveEffectiveOAuthCredentialCore(params: {
  profileId: string;
  credential: OAuthCredential;
  readBootstrapCredential: OAuthBootstrapCredentialReader;
}): OAuthCredential {
  if (isUserModelAuthProfileId(params.profileId)) {
    return params.credential;
  }
  const imported = params.readBootstrapCredential({
    profileId: params.profileId,
    credential: params.credential,
  });
  if (!imported) {
    return params.credential;
  }
  if (hasUsableOAuthCredential(params.credential)) {
    authProfilesLog.debug("resolved oauth credential from canonical local store", {
      profileId: params.profileId,
      provider: params.credential.provider,
      localExpires: params.credential.expires,
      externalExpires: imported.expires,
    });
    return params.credential;
  }
  if (!isSafeToAdoptBootstrapOAuthIdentity(params.credential, imported)) {
    authProfilesLog.warn(
      "refused external oauth bootstrap credential: identity mismatch or missing binding",
      {
        profileId: params.profileId,
        provider: params.credential.provider,
      },
    );
    return params.credential;
  }
  const shouldBootstrap = shouldBootstrapFromExternalCliCredential({
    existing: params.credential,
    imported,
  });
  if (shouldBootstrap) {
    authProfilesLog.debug("resolved oauth credential from external cli bootstrap", {
      profileId: params.profileId,
      provider: imported.provider,
      localExpires: params.credential.expires,
      externalExpires: imported.expires,
    });
    return imported;
  }
  return params.credential;
}

export function resolveEffectiveOAuthCredential(params: {
  profileId: string;
  credential: OAuthCredential;
}): OAuthCredential {
  return resolveEffectiveOAuthCredentialCore({
    ...params,
    readBootstrapCredential: readExternalCliBootstrapCredential,
  });
}
