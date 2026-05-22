import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-Bj7l9NI7.js";
import fs from "node:fs";
import path from "node:path";
//#region extensions/whatsapp/src/state-migrations.ts
function fileExists(pathValue) {
	try {
		return fs.existsSync(pathValue) && fs.statSync(pathValue).isFile();
	} catch {
		return false;
	}
}
function isLegacyWhatsAppAuthFile(name) {
	if (name === "creds.json" || name === "creds.json.bak") return true;
	if (!name.endsWith(".json")) return false;
	return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
}
function detectWhatsAppLegacyStateMigrations(params) {
	const targetDir = path.join(params.oauthDir, "whatsapp", DEFAULT_ACCOUNT_ID);
	return (() => {
		try {
			return fs.readdirSync(params.oauthDir, { withFileTypes: true });
		} catch {
			return [];
		}
	})().flatMap((entry) => {
		if (!entry.isFile() || entry.name === "oauth.json" || !isLegacyWhatsAppAuthFile(entry.name)) return [];
		const sourcePath = path.join(params.oauthDir, entry.name);
		const targetPath = path.join(targetDir, entry.name);
		if (fileExists(targetPath)) return [];
		return [{
			kind: "move",
			label: `WhatsApp auth ${entry.name}`,
			sourcePath,
			targetPath
		}];
	});
}
//#endregion
export { detectWhatsAppLegacyStateMigrations as t };
