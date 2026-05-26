import { s as statRegularFileSync } from "./regular-file-DaVeNX32.js";
import "./security-runtime-CcSekjBd.js";
import { t as resolveChannelAllowFromPath } from "./channel-pairing-paths-CjMFJb8Q.js";
import { n as resolveDefaultTelegramAccountId } from "./account-selection-DL49AGIt.js";
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
