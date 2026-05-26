import "./fs-safe-defaults-B7hUN42l.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { i as readSecretFileSync } from "./secret-file-DsUhZ-Ug.js";
//#region src/infra/secret-file.ts
/** @deprecated Use readSecretFileSync() or tryReadSecretFileSync(). */
function loadSecretFileSync(filePath, label, options = {}) {
	const resolvedPath = resolveUserPath(filePath.trim());
	if (!resolvedPath) return {
		ok: false,
		message: `${label} file path is empty.`
	};
	try {
		return {
			ok: true,
			secret: readSecretFileSync(filePath, label, options),
			resolvedPath
		};
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
			resolvedPath,
			error
		};
	}
}
//#endregion
export { loadSecretFileSync as t };
