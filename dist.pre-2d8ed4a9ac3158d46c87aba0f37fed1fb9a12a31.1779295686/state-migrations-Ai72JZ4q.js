import { s as statRegularFileSync } from "./regular-file-6GdZVPgG.js";
import "./security-runtime-DpTOaPkU.js";
import { t as resolveChannelAllowFromPath } from "./channel-pairing-paths-qkpMCI7a.js";
import { n as resolveDefaultTelegramAccountId } from "./account-selection-BG61Gs7u.js";
//#region extensions/telegram/src/state-migrations.ts
function fileExists(pathValue) {
	try {
		return !statRegularFileSync(pathValue).missing;
	} catch {
		return false;
	}
}
function detectTelegramLegacyStateMigrations(params) {
	const legacyPath = resolveChannelAllowFromPath("telegram", params.env);
	if (!fileExists(legacyPath)) return [];
	const accountId = resolveDefaultTelegramAccountId(params.cfg);
	const targetPath = resolveChannelAllowFromPath("telegram", params.env, accountId);
	if (fileExists(targetPath)) return [];
	return [{
		kind: "copy",
		label: "Telegram pairing allowFrom",
		sourcePath: legacyPath,
		targetPath
	}];
}
//#endregion
export { detectTelegramLegacyStateMigrations as t };
