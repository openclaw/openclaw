import { readManagedExternalCliCredential } from "./external-cli-sync.js";
import { resolveEffectiveOAuthCredential as resolveManagedOAuthCredential } from "./oauth-manager.js";
export function resolveEffectiveOAuthCredential(params) {
    return resolveManagedOAuthCredential({
        profileId: params.profileId,
        credential: params.credential,
        readBootstrapCredential: ({ profileId, credential }) => readManagedExternalCliCredential({
            profileId,
            credential,
        }),
    });
}
