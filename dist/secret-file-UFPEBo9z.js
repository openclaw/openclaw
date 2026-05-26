import { i as readSecretFileSync, t as DEFAULT_SECRET_FILE_MAX_BYTES } from "./secret-file-DsUhZ-Ug.js";
import "./secret-file-BmZ4BUYP.js";
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
