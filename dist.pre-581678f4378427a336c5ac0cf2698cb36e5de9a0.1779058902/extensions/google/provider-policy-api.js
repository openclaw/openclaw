import { a as normalizeGoogleProviderConfig } from "../../provider-policy-ji0eCJyk.js";
//#region extensions/google/provider-policy-api.ts
function normalizeConfig(params) {
	return normalizeGoogleProviderConfig(params.provider, params.providerConfig);
}
//#endregion
export { normalizeConfig };
