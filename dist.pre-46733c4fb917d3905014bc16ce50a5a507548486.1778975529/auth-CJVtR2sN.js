import { o as coerceSecretRef } from "./types.secrets-Co1lNtpa.js";
import { r as resolveRequiredConfiguredSecretRefInputString } from "./resolve-configured-secret-input-string-rh2X6EJM.js";
import { n as ensureAuthProfileStore } from "./store-Cm1yBhEt.js";
import { n as listProfilesForProvider } from "./profile-list-CL0_x_9s.js";
import "./provider-auth-BdVaafmp.js";
import "./secret-input-runtime-CcWXf71y.js";
import { t as PROVIDER_ID } from "./models-CSE10uaA.js";
//#region extensions/github-copilot/auth.ts
async function resolveFirstGithubToken(params) {
	const authStore = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
	const profileIds = listProfilesForProvider(authStore, PROVIDER_ID);
	const hasProfile = profileIds.length > 0;
	const githubToken = (params.env.COPILOT_GITHUB_TOKEN ?? params.env.GH_TOKEN ?? params.env.GITHUB_TOKEN ?? "").trim();
	if (githubToken || !hasProfile) return {
		githubToken,
		hasProfile
	};
	const profileId = profileIds[0];
	const profile = profileId ? authStore.profiles[profileId] : void 0;
	if (profile?.type !== "token") return {
		githubToken: "",
		hasProfile
	};
	const directToken = profile.token?.trim() ?? "";
	if (directToken) return {
		githubToken: directToken,
		hasProfile
	};
	const tokenRef = coerceSecretRef(profile.tokenRef);
	if (tokenRef?.source === "env" && tokenRef.id.trim()) return {
		githubToken: (params.env[tokenRef.id] ?? process.env[tokenRef.id] ?? "").trim(),
		hasProfile
	};
	if (tokenRef && params.config) try {
		return {
			githubToken: (await resolveRequiredConfiguredSecretRefInputString({
				config: params.config,
				env: params.env,
				value: profile.tokenRef,
				path: `providers.github-copilot.authProfiles.${profileId ?? "default"}.tokenRef`
			}))?.trim() ?? "",
			hasProfile
		};
	} catch {
		return {
			githubToken: "",
			hasProfile
		};
	}
	return {
		githubToken: "",
		hasProfile
	};
}
//#endregion
export { resolveFirstGithubToken as t };
