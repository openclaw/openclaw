import { o as coerceSecretRef } from "./types.secrets-0GsiwJ5t.js";
import { r as resolveRequiredConfiguredSecretRefInputString } from "./resolve-configured-secret-input-string-D4Mac7bj.js";
import { n as ensureAuthProfileStore } from "./store-DgtKpm0W.js";
import { n as listProfilesForProvider } from "./profile-list-5r7idSS3.js";
import "./provider-auth-CYiv4Uvo.js";
import "./secret-input-runtime-BOTCa4V4.js";
import { t as PROVIDER_ID } from "./models-4ezhiHAg.js";
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
