import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/infra/brew.ts
function isExecutable(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function resolveBrewFromPath(pathEnv = process.env.PATH) {
	for (const dir of (pathEnv ?? "").split(path.delimiter)) {
		const trimmed = dir.trim();
		if (!trimmed || !path.isAbsolute(trimmed)) continue;
		const candidate = path.join(trimmed, "brew");
		if (isExecutable(candidate)) return candidate;
	}
}
function resolveBrewPathDirs(opts) {
	const homeDir = opts?.homeDir ?? os.homedir();
	const dirs = [];
	dirs.push(path.join(homeDir, ".linuxbrew", "bin"));
	dirs.push(path.join(homeDir, ".linuxbrew", "sbin"));
	dirs.push("/home/linuxbrew/.linuxbrew/bin", "/home/linuxbrew/.linuxbrew/sbin");
	dirs.push("/opt/homebrew/bin", "/usr/local/bin");
	return dirs;
}
function resolveBrewExecutable(opts) {
	const homeDir = opts?.homeDir ?? os.homedir();
	const pathBrew = resolveBrewFromPath();
	if (pathBrew) return pathBrew;
	const candidates = [];
	candidates.push(path.join(homeDir, ".linuxbrew", "bin", "brew"));
	candidates.push("/home/linuxbrew/.linuxbrew/bin/brew");
	candidates.push("/opt/homebrew/bin/brew", "/usr/local/bin/brew");
	for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
}
//#endregion
export { resolveBrewPathDirs as n, resolveBrewExecutable as t };
