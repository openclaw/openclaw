import path from "node:path";
import os from "node:os";
//#region src/infra/home-dir.ts
function normalize$1(value) {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === "undefined" || trimmed === "null") return;
	return trimmed;
}
function normalizeSafe(homedir) {
	try {
		return normalize$1(homedir());
	} catch {
		return;
	}
}
function resolveRawOsHomeDir(env, homedir) {
	return normalize$1(env.HOME) ?? normalize$1(env.USERPROFILE) ?? normalizeSafe(homedir);
}
function resolveRawHomeDir(env, homedir) {
	const explicitHome = normalize$1(env.OPENCLAW_HOME);
	if (!explicitHome) return resolveRawOsHomeDir(env, homedir);
	if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
		const fallbackHome = resolveRawOsHomeDir(env, homedir);
		return fallbackHome ? explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome) : void 0;
	}
	return explicitHome;
}
function resolveEffectiveHomeDir(env = process.env, homedir = os.homedir) {
	const raw = resolveRawHomeDir(env, homedir);
	return raw ? path.resolve(raw) : void 0;
}
function resolveOsHomeDir(env = process.env, homedir = os.homedir) {
	const raw = resolveRawOsHomeDir(env, homedir);
	return raw ? path.resolve(raw) : void 0;
}
function resolveRequiredHomeDir(env = process.env, homedir = os.homedir) {
	return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
function resolveRequiredOsHomeDir(env = process.env, homedir = os.homedir) {
	return resolveOsHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
function expandHomePrefix(input, opts) {
	if (!input.startsWith("~")) return input;
	const home = normalize$1(opts?.home) ?? resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
	if (!home) return input;
	return input.replace(/^~(?=$|[\\/])/, home);
}
function resolveHomeRelativePath(input, opts) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		const expanded = expandHomePrefix(trimmed, {
			home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
			env: opts?.env,
			homedir: opts?.homedir
		});
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}
function resolveUserPath(input, env = process.env, homedir = os.homedir) {
	return resolveHomeRelativePath(input, {
		env,
		homedir
	});
}
function resolveOsHomeRelativePath(input, opts) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		const expanded = expandHomePrefix(trimmed, {
			home: resolveRequiredOsHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
			env: opts?.env,
			homedir: opts?.homedir
		});
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}
//#endregion
export { resolveOsHomeRelativePath as a, resolveUserPath as c, resolveOsHomeDir as i, resolveEffectiveHomeDir as n, resolveRequiredHomeDir as o, resolveHomeRelativePath as r, resolveRequiredOsHomeDir as s, expandHomePrefix as t };
