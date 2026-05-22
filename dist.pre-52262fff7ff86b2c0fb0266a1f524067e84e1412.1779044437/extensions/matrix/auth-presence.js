import { v as resolveStateDir } from "../../paths-Cnwfh6dH.js";
import "../../state-paths-tL1LzAVr.js";
import { i as resolveMatrixCredentialsFilename, r as resolveMatrixCredentialsDir } from "../../storage-paths-DHq8ICz-.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region extensions/matrix/auth-presence.ts
function listMatrixCredentialPaths(_cfg, env = process.env) {
	const credentialsDir = resolveMatrixCredentialsDir(resolveStateDir(env, os.homedir));
	const paths = new Set([resolveMatrixCredentialsFilename(), resolveMatrixCredentialsFilename("default")]);
	try {
		const entries = fs.readdirSync(credentialsDir, { withFileTypes: true });
		for (const entry of entries) if (entry.isFile() && /^credentials(?:-[a-z0-9._-]+)?\.json$/i.test(entry.name)) paths.add(entry.name);
	} catch {}
	return [...paths].map((filename) => path.join(credentialsDir, filename));
}
function hasAnyMatrixAuth(params, env = process.env) {
	return listMatrixCredentialPaths(params && typeof params === "object" && "cfg" in params ? params.cfg : params, params && typeof params === "object" && "cfg" in params ? params.env ?? env : env).some((filePath) => {
		try {
			return fs.existsSync(filePath);
		} catch {
			return false;
		}
	});
}
//#endregion
export { hasAnyMatrixAuth };
