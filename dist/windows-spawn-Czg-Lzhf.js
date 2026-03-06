import path from "node:path";
import { readFileSync, statSync } from "node:fs";

//#region src/plugin-sdk/windows-spawn.ts
function isFilePath(candidate) {
	try {
		return statSync(candidate).isFile();
	} catch {
		return false;
	}
}
function resolveWindowsExecutablePath(command, env) {
	if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) return command;
	const pathEntries = (env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? "").split(";").map((entry) => entry.trim()).filter(Boolean);
	const hasExtension = path.extname(command).length > 0;
	const pathExtRaw = env.PATHEXT ?? env.Pathext ?? process.env.PATHEXT ?? process.env.Pathext ?? ".EXE;.CMD;.BAT;.COM";
	const pathExt = hasExtension ? [""] : pathExtRaw.split(";").map((ext) => ext.trim()).filter(Boolean).map((ext) => ext.startsWith(".") ? ext : `.${ext}`);
	for (const dir of pathEntries) for (const ext of pathExt) for (const candidateExt of [
		ext,
		ext.toLowerCase(),
		ext.toUpperCase()
	]) {
		const candidate = path.join(dir, `${command}${candidateExt}`);
		if (isFilePath(candidate)) return candidate;
	}
	return command;
}
function resolveEntrypointFromCmdShim(wrapperPath) {
	if (!isFilePath(wrapperPath)) return null;
	try {
		const content = readFileSync(wrapperPath, "utf8");
		const candidates = [];
		for (const match of content.matchAll(/"([^"\r\n]*)"/g)) {
			const relative = (match[1] ?? "").match(/%~?dp0%?\s*[\\/]*(.*)$/i)?.[1]?.trim();
			if (!relative) continue;
			const normalizedRelative = relative.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, "");
			const candidate = path.resolve(path.dirname(wrapperPath), normalizedRelative);
			if (isFilePath(candidate)) candidates.push(candidate);
		}
		return candidates.find((candidate) => {
			const base = path.basename(candidate).toLowerCase();
			return base !== "node.exe" && base !== "node";
		}) ?? null;
	} catch {
		return null;
	}
}
function resolveBinEntry(packageName, binField) {
	if (typeof binField === "string") return binField.trim() || null;
	if (!binField || typeof binField !== "object") return null;
	if (packageName) {
		const preferred = binField[packageName];
		if (typeof preferred === "string" && preferred.trim()) return preferred.trim();
	}
	for (const value of Object.values(binField)) if (typeof value === "string" && value.trim()) return value.trim();
	return null;
}
function resolveEntrypointFromPackageJson(wrapperPath, packageName) {
	if (!packageName) return null;
	const wrapperDir = path.dirname(wrapperPath);
	const packageDirs = [path.resolve(wrapperDir, "..", packageName), path.resolve(wrapperDir, "node_modules", packageName)];
	for (const packageDir of packageDirs) {
		const packageJsonPath = path.join(packageDir, "package.json");
		if (!isFilePath(packageJsonPath)) continue;
		try {
			const entryRel = resolveBinEntry(packageName, JSON.parse(readFileSync(packageJsonPath, "utf8")).bin);
			if (!entryRel) continue;
			const entryPath = path.resolve(packageDir, entryRel);
			if (isFilePath(entryPath)) return entryPath;
		} catch {}
	}
	return null;
}
function resolveWindowsSpawnProgramCandidate(params) {
	const platform = params.platform ?? process.platform;
	const env = params.env ?? process.env;
	const execPath = params.execPath ?? process.execPath;
	if (platform !== "win32") return {
		command: params.command,
		leadingArgv: [],
		resolution: "direct"
	};
	const resolvedCommand = resolveWindowsExecutablePath(params.command, env);
	const ext = path.extname(resolvedCommand).toLowerCase();
	if (ext === ".js" || ext === ".cjs" || ext === ".mjs") return {
		command: execPath,
		leadingArgv: [resolvedCommand],
		resolution: "node-entrypoint",
		windowsHide: true
	};
	if (ext === ".cmd" || ext === ".bat") {
		const entrypoint = resolveEntrypointFromCmdShim(resolvedCommand) ?? resolveEntrypointFromPackageJson(resolvedCommand, params.packageName);
		if (entrypoint) {
			if (path.extname(entrypoint).toLowerCase() === ".exe") return {
				command: entrypoint,
				leadingArgv: [],
				resolution: "exe-entrypoint",
				windowsHide: true
			};
			return {
				command: execPath,
				leadingArgv: [entrypoint],
				resolution: "node-entrypoint",
				windowsHide: true
			};
		}
		return {
			command: resolvedCommand,
			leadingArgv: [],
			resolution: "unresolved-wrapper"
		};
	}
	return {
		command: resolvedCommand,
		leadingArgv: [],
		resolution: "direct"
	};
}
function applyWindowsSpawnProgramPolicy(params) {
	if (params.candidate.resolution !== "unresolved-wrapper") return {
		command: params.candidate.command,
		leadingArgv: params.candidate.leadingArgv,
		resolution: params.candidate.resolution,
		windowsHide: params.candidate.windowsHide
	};
	if (params.allowShellFallback !== false) return {
		command: params.candidate.command,
		leadingArgv: [],
		resolution: "shell-fallback",
		shell: true
	};
	throw new Error(`${path.basename(params.candidate.command)} wrapper resolved, but no executable/Node entrypoint could be resolved without shell execution.`);
}
function resolveWindowsSpawnProgram(params) {
	return applyWindowsSpawnProgramPolicy({
		candidate: resolveWindowsSpawnProgramCandidate(params),
		allowShellFallback: params.allowShellFallback
	});
}
function materializeWindowsSpawnProgram(program, argv) {
	return {
		command: program.command,
		argv: [...program.leadingArgv, ...argv],
		resolution: program.resolution,
		shell: program.shell,
		windowsHide: program.windowsHide
	};
}

//#endregion
export { resolveWindowsSpawnProgram as n, materializeWindowsSpawnProgram as t };