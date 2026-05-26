import { f as readStringValue } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/google/oauth-token-shared.ts
function parseGoogleOauthApiKey(apiKey) {
	try {
		const parsed = JSON.parse(apiKey);
		return {
			token: readStringValue(parsed.token),
			projectId: readStringValue(parsed.projectId)
		};
	} catch {
		return null;
	}
}
function formatGoogleOauthApiKey(cred) {
	if (cred.type !== "oauth" || typeof cred.access !== "string" || !cred.access.trim()) return "";
	return JSON.stringify({
		token: cred.access,
		projectId: cred.projectId
	});
}
function parseGoogleUsageToken(apiKey) {
	const parsed = parseGoogleOauthApiKey(apiKey);
	if (parsed?.token) return parsed.token;
	return apiKey;
}
//#endregion
export { parseGoogleOauthApiKey as n, parseGoogleUsageToken as r, formatGoogleOauthApiKey as t };
