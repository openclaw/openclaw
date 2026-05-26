import { a as normalizeGoogleProviderConfig } from "../../provider-policy-DW2giv4S.js";
//#region extensions/google/provider-policy-api.ts
function normalizeConfig(params) {
	return normalizeGoogleProviderConfig(params.provider, params.providerConfig);
}
//#endregion
export { normalizeConfig };
