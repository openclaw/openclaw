import { t as buildAuthProfileId } from "./identity-I-a6exgW.js";
//#region src/plugin-sdk/provider-auth-result.ts
/** Build the standard auth result payload for OAuth-style provider login flows. */
function buildOauthProviderAuthResult(params) {
	const email = params.email ?? void 0;
	const displayName = params.displayName ?? void 0;
	return {
		profiles: [{
			profileId: buildAuthProfileId({
				providerId: params.providerId,
				profilePrefix: params.profilePrefix,
				profileName: params.profileName ?? email
			}),
			credential: {
				type: "oauth",
				provider: params.providerId,
				access: params.access,
				...params.refresh ? { refresh: params.refresh } : {},
				...Number.isFinite(params.expires) ? { expires: params.expires } : {},
				...email ? { email } : {},
				...displayName ? { displayName } : {},
				...params.credentialExtra
			}
		}],
		configPatch: params.configPatch ?? { agents: { defaults: { models: { [params.defaultModel]: {} } } } },
		defaultModel: params.defaultModel,
		notes: params.notes
	};
}
//#endregion
export { buildOauthProviderAuthResult as t };
