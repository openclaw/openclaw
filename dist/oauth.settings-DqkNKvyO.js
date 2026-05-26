import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
//#region extensions/google/oauth.settings.ts
const defaultFs = {
	existsSync,
	readFileSync,
	homedir
};
let oauthSettingsFs = defaultFs;
function readSettingsFile() {
	const settingsPath = join(oauthSettingsFs.homedir(), ".gemini", "settings.json");
	if (!oauthSettingsFs.existsSync(settingsPath)) return null;
	try {
		const parsed = JSON.parse(oauthSettingsFs.readFileSync(settingsPath, "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
function setOAuthSettingsFsForTest(overrides) {
	oauthSettingsFs = overrides ? {
		...defaultFs,
		...overrides
	} : defaultFs;
}
function resolveGeminiCliSelectedAuthType() {
	const settings = readSettingsFile();
	if (settings) {
		const security = isRecord(settings.security) ? settings.security : void 0;
		const auth = isRecord(security?.auth) ? security.auth : void 0;
		const selectedAuthType = normalizeOptionalString(auth?.selectedType) ?? normalizeOptionalString(auth?.enforcedType) ?? normalizeOptionalString(settings.selectedAuthType) ?? normalizeOptionalString(settings.enforcedAuthType);
		if (selectedAuthType) return selectedAuthType;
	}
	if (process.env.GOOGLE_GENAI_USE_GCA === "true") return "oauth-personal";
}
function isGeminiCliPersonalOAuth() {
	return resolveGeminiCliSelectedAuthType() === "oauth-personal";
}
//#endregion
export { resolveGeminiCliSelectedAuthType as n, setOAuthSettingsFsForTest as r, isGeminiCliPersonalOAuth as t };
