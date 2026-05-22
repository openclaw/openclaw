import { i as readSecretFileSync, t as DEFAULT_SECRET_FILE_MAX_BYTES } from "./secret-file-wDy6AUxS.js";
import "./secret-file-BeEiJCn7.js";
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
