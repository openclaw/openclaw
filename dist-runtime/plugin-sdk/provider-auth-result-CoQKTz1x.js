//#region src/plugin-sdk/provider-auth-result.ts
/** Build the standard auth result payload for OAuth-style provider login flows. */
function buildOauthProviderAuthResult(params) {
	const email = params.email ?? void 0;
	return {
		profiles: [{
			profileId: `${params.profilePrefix ?? params.providerId}:${email ?? "default"}`,
			credential: {
				type: "oauth",
				provider: params.providerId,
				access: params.access,
				...params.refresh ? { refresh: params.refresh } : {},
				...Number.isFinite(params.expires) ? { expires: params.expires } : {},
				...email ? { email } : {},
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
