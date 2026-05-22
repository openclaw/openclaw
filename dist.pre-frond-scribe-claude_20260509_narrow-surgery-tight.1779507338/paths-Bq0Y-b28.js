import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveGatewayProfileSuffix } from "./constants-CmvvKVqh.js";
import path from "node:path";
//#region src/daemon/paths.ts
const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;
function resolveHomeDir(env) {
	const home = normalizeOptionalString(env.HOME) || normalizeOptionalString(env.USERPROFILE);
	if (!home) throw new Error("Missing HOME");
	return home;
}
function resolveUserPathWithHome(input, home) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		if (!home) throw new Error("Missing HOME");
		const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
		return path.resolve(expanded);
	}
	if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) return trimmed;
	return path.resolve(trimmed);
}
function resolveGatewayStateDir(env) {
	const override = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
	if (override) return resolveUserPathWithHome(override, override.startsWith("~") ? resolveHomeDir(env) : void 0);
	const home = resolveHomeDir(env);
	const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
	return path.join(home, `.openclaw${suffix}`);
}
//#endregion
export { resolveHomeDir as n, resolveGatewayStateDir as t };
