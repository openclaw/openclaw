import "./store-cache-DVY0vN3D.js";
import "./store-C9PhwTe-.js";
import { n as resolveAuthProfileMetadata } from "./identity-B9_6eGVi.js";
import "./oauth-Dm9ArmB2.js";
import "./profiles-B4o8ulLL.js";
import "./repair-CcjkjBA8.js";
import "./order-CBFEqgPs.js";
import "./usage-BIRjpfuK.js";
//#region src/agents/auth-profiles/display.ts
function resolveAuthProfileDisplayLabel(params) {
	const { displayName, email } = resolveAuthProfileMetadata(params);
	if (displayName) return `${params.profileId} (${displayName})`;
	if (email) return `${params.profileId} (${email})`;
	return params.profileId;
}
//#endregion
//#region src/agents/auth-profiles/portability.ts
function hasAgentCopyOverride(credential) {
	return typeof credential.copyToAgents === "boolean" ? credential.copyToAgents : void 0;
}
function hasCopyableOAuthMaterial(credential) {
	if (credential.type !== "oauth") return false;
	return [credential.access, credential.refresh].some((value) => typeof value === "string" && value.trim().length > 0);
}
function resolveAuthProfilePortability(credential) {
	const override = hasAgentCopyOverride(credential);
	if (override === false) return {
		portable: false,
		reason: "credential-opted-out"
	};
	if (credential.type === "oauth") {
		if (!hasCopyableOAuthMaterial(credential)) return {
			portable: false,
			reason: "non-portable-oauth-refresh-token"
		};
		return override === true ? {
			portable: true,
			reason: "oauth-provider-opted-in"
		} : {
			portable: false,
			reason: "non-portable-oauth-refresh-token"
		};
	}
	return {
		portable: true,
		reason: "portable-static-credential"
	};
}
function isAuthProfileCredentialPortableForAgentCopy(credential) {
	return resolveAuthProfilePortability(credential).portable;
}
function buildPortableAuthProfileSecretsStoreForAgentCopy(store) {
	const copiedProfileIds = [];
	const skippedProfileIds = [];
	return {
		store: {
			version: 1,
			profiles: Object.fromEntries(Object.entries(store.profiles).flatMap(([profileId, credential]) => {
				if (!isAuthProfileCredentialPortableForAgentCopy(credential)) {
					skippedProfileIds.push(profileId);
					return [];
				}
				copiedProfileIds.push(profileId);
				return [[profileId, credential]];
			}))
		},
		copiedProfileIds,
		skippedProfileIds
	};
}
//#endregion
export { resolveAuthProfileDisplayLabel as i, isAuthProfileCredentialPortableForAgentCopy as n, resolveAuthProfilePortability as r, buildPortableAuthProfileSecretsStoreForAgentCopy as t };
