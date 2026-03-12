import { c as BOUNDARY_PATH_ALIAS_POLICIES, d as isNotFoundPathError, l as resolveBoundaryPath } from "./openclaw-root-PhSD0wUu.js";
import os from "node:os";
import fs from "node:fs/promises";

//#region src/infra/hardlink-guards.ts
async function assertNoHardlinkedFinalPath(params) {
	if (params.allowFinalHardlinkForUnlink) return;
	let stat;
	try {
		stat = await fs.stat(params.filePath);
	} catch (err) {
		if (isNotFoundPathError(err)) return;
		throw err;
	}
	if (!stat.isFile()) return;
	if (stat.nlink > 1) throw new Error(`Hardlinked path is not allowed under ${params.boundaryLabel} (${shortPath(params.root)}): ${shortPath(params.filePath)}`);
}
function shortPath(value) {
	if (value.startsWith(os.homedir())) return `~${value.slice(os.homedir().length)}`;
	return value;
}

//#endregion
//#region src/infra/path-alias-guards.ts
const PATH_ALIAS_POLICIES = BOUNDARY_PATH_ALIAS_POLICIES;
async function assertNoPathAliasEscape(params) {
	const resolved = await resolveBoundaryPath({
		absolutePath: params.absolutePath,
		rootPath: params.rootPath,
		boundaryLabel: params.boundaryLabel,
		policy: params.policy
	});
	if (params.policy?.allowFinalSymlinkForUnlink === true && resolved.kind === "symlink") return;
	await assertNoHardlinkedFinalPath({
		filePath: resolved.absolutePath,
		root: resolved.rootPath,
		boundaryLabel: params.boundaryLabel,
		allowFinalHardlinkForUnlink: params.policy?.allowFinalHardlinkForUnlink
	});
}

//#endregion
export { assertNoPathAliasEscape as n, PATH_ALIAS_POLICIES as t };