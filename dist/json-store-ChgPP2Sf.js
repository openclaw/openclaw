import "./fs-safe-defaults-B7hUN42l.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { h as writeJsonSync, m as writeJson, o as tryReadJson, p as tryReadJsonSync } from "./json-files-C2hqjU--.js";
//#region src/plugin-sdk/json-store.ts
/** Read small JSON blobs synchronously for token/state caches. */
function loadJsonFile(filePath) {
	return tryReadJsonSync(filePath) ?? void 0;
}
/** Persist small JSON blobs synchronously with restrictive permissions. */
const saveJsonFile = writeJsonSync;
/** Read JSON from disk and fall back cleanly when the file is missing or invalid. */
async function readJsonFileWithFallback(filePath, fallback) {
	const parsed = await tryReadJson(filePath);
	if (parsed != null) return {
		value: parsed,
		exists: true
	};
	return {
		value: fallback,
		exists: await pathExists(filePath)
	};
}
/** Write JSON with secure file permissions and atomic replacement semantics. */
async function writeJsonFileAtomically(filePath, value) {
	await writeJson(filePath, value, {
		mode: 384,
		dirMode: 448,
		trailingNewline: true
	});
}
//#endregion
export { writeJsonFileAtomically as i, readJsonFileWithFallback as n, saveJsonFile as r, loadJsonFile as t };
