import fs from "node:fs";
import os from "node:os";
import path from "node:path";

//#region src/infra/brew.ts
function isExecutable(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function normalizePathValue(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function resolveBrewPathDirs(opts) {
	const homeDir = opts?.homeDir ?? os.homedir();
	const env = opts?.env ?? process.env;
	const dirs = [];
	const prefix = normalizePathValue(env.HOMEBREW_PREFIX);
	if (prefix) dirs.push(path.join(prefix, "bin"), path.join(prefix, "sbin"));
	dirs.push(path.join(homeDir, ".linuxbrew", "bin"));
	dirs.push(path.join(homeDir, ".linuxbrew", "sbin"));
	dirs.push("/home/linuxbrew/.linuxbrew/bin", "/home/linuxbrew/.linuxbrew/sbin");
	dirs.push("/opt/homebrew/bin", "/usr/local/bin");
	return dirs;
}
function resolveBrewExecutable(opts) {
	const homeDir = opts?.homeDir ?? os.homedir();
	const env = opts?.env ?? process.env;
	const candidates = [];
	const brewFile = normalizePathValue(env.HOMEBREW_BREW_FILE);
	if (brewFile) candidates.push(brewFile);
	const prefix = normalizePathValue(env.HOMEBREW_PREFIX);
	if (prefix) candidates.push(path.join(prefix, "bin", "brew"));
	candidates.push(path.join(homeDir, ".linuxbrew", "bin", "brew"));
	candidates.push("/home/linuxbrew/.linuxbrew/bin/brew");
	candidates.push("/opt/homebrew/bin/brew", "/usr/local/bin/brew");
	for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
}

//#endregion
export { resolveBrewPathDirs as n, resolveBrewExecutable as t };