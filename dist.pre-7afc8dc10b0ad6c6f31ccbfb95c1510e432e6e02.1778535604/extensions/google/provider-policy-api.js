import { a as normalizeGoogleProviderConfig } from "../../provider-policy-BJV8_sZW.js";
//#region extensions/google/provider-policy-api.ts
function normalizeConfig(params) {
	return normalizeGoogleProviderConfig(params.provider, params.providerConfig);
}
//#endregion
export { normalizeConfig };
