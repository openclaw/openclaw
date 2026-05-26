import { r as hasAnyRuntimeAuthProfileStoreSource } from "./runtime-snapshots-esDr_mQ_.js";
import { a as resolveLegacyAuthStorePath, r as resolveAuthStorePath, t as resolveAuthStatePath } from "./path-resolve-C6Vj5eOM.js";
import fs from "node:fs";
//#region src/agents/auth-profiles/source-check.ts
function hasStoredAuthProfileFiles(agentDir) {
	return fs.existsSync(resolveAuthStorePath(agentDir)) || fs.existsSync(resolveAuthStatePath(agentDir)) || fs.existsSync(resolveLegacyAuthStorePath(agentDir));
}
function hasAnyAuthProfileStoreSource(agentDir) {
	if (hasAnyRuntimeAuthProfileStoreSource(agentDir)) return true;
	if (hasStoredAuthProfileFiles(agentDir)) return true;
	const authPath = resolveAuthStorePath(agentDir);
	const mainAuthPath = resolveAuthStorePath();
	if (agentDir && authPath !== mainAuthPath && hasStoredAuthProfileFiles(void 0)) return true;
	return false;
}
//#endregion
export { hasAnyAuthProfileStoreSource as t };
