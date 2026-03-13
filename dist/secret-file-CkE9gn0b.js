import { C as readSecretFileSync, S as DEFAULT_SECRET_FILE_MAX_BYTES } from "./plugins-By9GTgrF.js";
//#region src/acp/secret-file.ts
const MAX_SECRET_FILE_BYTES = DEFAULT_SECRET_FILE_MAX_BYTES;
function readSecretFromFile(filePath, label) {
	return readSecretFileSync(filePath, label, {
		maxBytes: MAX_SECRET_FILE_BYTES,
		rejectSymlink: true
	});
}
//#endregion
export { readSecretFromFile as t };
