import "./store-a4exFSck.js";
import { n as resolveAuthProfileMetadata } from "./identity-DX9yGpYy.js";
import "./oauth-B8qSiLIG.js";
import "./repair-CzDi-eiN.js";
import "./order-YU9choem.js";
import "./profiles-Bj_dclxz.js";
import "./usage-nwVzxGxo.js";
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
function resolveAuthProfilePortability(credential) {
	const override = hasAgentCopyOverride(credential);
	if (override === false) return {
		portable: false,
		reason: "credential-opted-out"
	};
	if (credential.type === "oauth") return override === true ? {
		portable: true,
		reason: "oauth-provider-opted-in"
	} : {
		portable: false,
		reason: "non-portable-oauth-refresh-token"
	};
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
