import { resolveExternalAuthProfilesWithPlugins } from "../../plugins/provider-runtime.js";
import * as externalCliSync from "./external-cli-sync.js";
import { overlayRuntimeExternalOAuthProfiles, shouldPersistRuntimeExternalOAuthProfile, } from "./oauth-shared.js";
let resolveExternalAuthProfilesForRuntime;
export const __testing = {
    resetResolveExternalAuthProfilesForTest() {
        resolveExternalAuthProfilesForRuntime = undefined;
    },
    setResolveExternalAuthProfilesForTest(resolver) {
        resolveExternalAuthProfilesForRuntime = resolver;
    },
};
function normalizeExternalAuthProfile(profile) {
    if (!profile?.profileId || !profile.credential) {
        return null;
    }
    return {
        ...profile,
        persistence: profile.persistence ?? "runtime-only",
    };
}
function resolveExternalAuthProfileMap(params) {
    const env = params.env ?? process.env;
    const resolveProfiles = resolveExternalAuthProfilesForRuntime ?? resolveExternalAuthProfilesWithPlugins;
    const profiles = resolveProfiles({
        env,
        context: {
            config: undefined,
            agentDir: params.agentDir,
            workspaceDir: undefined,
            env,
            store: params.store,
        },
    });
    const resolved = new Map();
    const cliProfiles = externalCliSync.resolveExternalCliAuthProfiles?.(params.store) ?? [];
    for (const profile of cliProfiles) {
        resolved.set(profile.profileId, {
            profileId: profile.profileId,
            credential: profile.credential,
            persistence: "runtime-only",
        });
    }
    for (const rawProfile of profiles) {
        const profile = normalizeExternalAuthProfile(rawProfile);
        if (!profile) {
            continue;
        }
        resolved.set(profile.profileId, profile);
    }
    return resolved;
}
function listRuntimeExternalAuthProfiles(params) {
    return Array.from(resolveExternalAuthProfileMap({
        store: params.store,
        agentDir: params.agentDir,
        env: params.env,
    }).values());
}
export function overlayExternalAuthProfiles(store, params) {
    const profiles = listRuntimeExternalAuthProfiles({
        store,
        agentDir: params?.agentDir,
        env: params?.env,
    });
    return overlayRuntimeExternalOAuthProfiles(store, profiles);
}
export function shouldPersistExternalAuthProfile(params) {
    const profiles = listRuntimeExternalAuthProfiles({
        store: params.store,
        agentDir: params.agentDir,
        env: params.env,
    });
    return shouldPersistRuntimeExternalOAuthProfile({
        profileId: params.profileId,
        credential: params.credential,
        profiles,
    });
}
// Compat aliases while file/function naming catches up.
export const overlayExternalOAuthProfiles = overlayExternalAuthProfiles;
export const shouldPersistExternalOAuthProfile = shouldPersistExternalAuthProfile;
