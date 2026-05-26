import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { n as resolveBrewPathDirs } from "./brew-B6RYZvsE.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/infra/path-env.ts
function isExecutable(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function isDirectory(dirPath) {
	try {
		return fs.statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}
function splitPathParts(pathEnv) {
	return new Set(pathEnv.split(path.delimiter).map((part) => part.trim()).filter(Boolean));
}
function isKnownPathDir(existingPathParts, dirPath) {
	return existingPathParts.has(dirPath) || isDirectory(dirPath);
}
function isLinuxbrewPath(dirPath) {
	return dirPath.split(path.sep).includes(".linuxbrew");
}
function resolvePathBootstrapBrewDirs(params) {
	const candidates = resolveBrewPathDirs({ homeDir: params.homeDir });
	if (params.platform !== "darwin") return candidates;
	return candidates.filter((candidate) => !isLinuxbrewPath(candidate) || params.existingPathParts.has(candidate));
}
function mergePath(params) {
	const partsExisting = params.existing.split(path.delimiter).map((part) => part.trim()).filter(Boolean);
	const partsPrepend = (params.prepend ?? []).map((part) => part.trim()).filter(Boolean);
	const partsAppend = (params.append ?? []).map((part) => part.trim()).filter(Boolean);
	const seen = /* @__PURE__ */ new Set();
	const merged = [];
	for (const part of [
		...partsPrepend,
		...partsExisting,
		...partsAppend
	]) if (!seen.has(part)) {
		seen.add(part);
		merged.push(part);
	}
	return merged.join(path.delimiter);
}
function candidateBinDirs(opts, existingPathParts) {
	const execPath = opts.execPath ?? process.execPath;
	const cwd = opts.cwd ?? process.cwd();
	const homeDir = opts.homeDir ?? os.homedir();
	const platform = opts.platform ?? process.platform;
	const prepend = [];
	const append = [];
	try {
		const execDir = path.dirname(execPath);
		if (isExecutable(execPath)) prepend.push(execDir);
	} catch {}
	try {
		const execDir = path.dirname(execPath);
		if (isExecutable(path.join(execDir, "openclaw"))) prepend.push(execDir);
	} catch {}
	if (opts.allowProjectLocalBin === true || isTruthyEnvValue(process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN)) {
		const localBinDir = path.join(cwd, "node_modules", ".bin");
		if (isExecutable(path.join(localBinDir, "openclaw"))) append.push(localBinDir);
	}
	prepend.push("/usr/bin", "/bin");
	append.push(...resolvePathBootstrapBrewDirs({
		homeDir,
		platform,
		existingPathParts
	}));
	const miseDataDir = process.env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
	const miseShims = path.join(miseDataDir, "shims");
	if (isKnownPathDir(existingPathParts, miseShims)) append.push(miseShims);
	if (platform === "darwin") append.push(path.join(homeDir, "Library", "pnpm"));
	if (process.env.XDG_BIN_HOME) append.push(process.env.XDG_BIN_HOME);
	append.push(path.join(homeDir, ".local", "bin"));
	append.push(path.join(homeDir, ".local", "share", "pnpm"));
	append.push(path.join(homeDir, ".bun", "bin"));
	append.push(path.join(homeDir, ".yarn", "bin"));
	return {
		prepend: prepend.filter((candidate) => isKnownPathDir(existingPathParts, candidate)),
		append: append.filter((candidate) => isKnownPathDir(existingPathParts, candidate))
	};
}
/**
* Best-effort PATH bootstrap so skills that require the `openclaw` CLI can run
* under launchd/minimal environments (and inside the macOS app bundle).
*/
function ensureOpenClawCliOnPath(opts = {}) {
	if (isTruthyEnvValue(process.env.OPENCLAW_PATH_BOOTSTRAPPED)) return;
	process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";
	const existing = opts.pathEnv ?? process.env.PATH ?? "";
	const { prepend, append } = candidateBinDirs(opts, splitPathParts(existing));
	if (prepend.length === 0 && append.length === 0) return;
	const merged = mergePath({
		existing,
		prepend,
		append
	});
	if (merged) process.env.PATH = merged;
}
//#endregion
export { ensureOpenClawCliOnPath as t };
