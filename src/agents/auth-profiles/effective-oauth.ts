import {
  hasUsableOAuthCredential,
  readManagedExternalCliCredential,
  shouldBootstrapFromExternalCliCredential,
} from "./external-cli-sync.js";
import type { OAuthCredential } from "./types.js";

export function resolveEffectiveOAuthCredential(params: {
  profileId: string;
  credential: OAuthCredential;
}): OAuthCredential {
  const imported = readManagedExternalCliCredential({
    profileId: params.profileId,
    credential: params.credential,
  });
  if (!imported) {
    return params.credential;
  }
  if (hasUsableOAuthCredential(params.credential)) {
    return params.credential;
  }
  return shouldBootstrapFromExternalCliCredential({
    existing: params.credential,
    imported,
  })
    ? imported
    : params.credential;
}
