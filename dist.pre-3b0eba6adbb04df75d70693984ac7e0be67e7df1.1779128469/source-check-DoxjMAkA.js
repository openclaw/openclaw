import { d as resolveLegacyAuthStorePath, l as resolveAuthStorePath, r as hasAnyRuntimeAuthProfileStoreSource, s as resolveAuthStatePath } from "./runtime-snapshots-DMGDLaeG.js";
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
