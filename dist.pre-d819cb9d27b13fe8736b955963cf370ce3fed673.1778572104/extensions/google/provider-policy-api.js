import { a as normalizeGoogleProviderConfig } from "../../provider-policy-Be1OBlu0.js";
//#region extensions/google/provider-policy-api.ts
function normalizeConfig(params) {
	return normalizeGoogleProviderConfig(params.provider, params.providerConfig);
}
//#endregion
export { normalizeConfig };
