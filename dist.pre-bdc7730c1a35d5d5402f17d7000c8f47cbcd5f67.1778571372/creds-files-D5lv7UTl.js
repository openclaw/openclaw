import fs from "node:fs";
import path from "node:path";
//#region extensions/whatsapp/src/creds-files.ts
function resolveWebCredsPath(authDir) {
	return path.join(authDir, "creds.json");
}
function resolveWebCredsBackupPath(authDir) {
	return path.join(authDir, "creds.json.bak");
}
function hasWebCredsSync(authDir) {
	try {
		const stats = fs.statSync(resolveWebCredsPath(authDir));
		return stats.isFile() && stats.size > 1;
	} catch {
		return false;
	}
}
//#endregion
export { resolveWebCredsBackupPath as n, resolveWebCredsPath as r, hasWebCredsSync as t };
