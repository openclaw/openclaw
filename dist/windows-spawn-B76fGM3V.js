import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
//#region src/plugin-sdk/windows-spawn.ts
const INLINE_ARGUMENT_EXECUTABLES = new Set([
	"node",
	"node.exe",
	"npm",
	"npm.cmd",
	"npm.exe",
	"npx",
	"npx.cmd",
	"npx.exe",
	"pnpm",
	"pnpm.cmd",
	"pnpm.exe",
	"yarn",
	"yarn.cmd",
	"yarn.exe"
]);
function isFilePath(candidate) {
	try {
		return statSync(candidate).isFile();
	} catch {
		return false;
	}
}
function readCommandToken(command) {
	const trimmed = command.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("\"")) {
		const closeIndex = trimmed.indexOf("\"", 1);
		if (closeIndex <= 0) return null;
		return {
			token: trimmed.slice(1, closeIndex),
			rest: trimmed.slice(closeIndex + 1).trim()
		};
	}
	const match = trimmed.match(/^(\S+)\s+(.+)$/);
	if (!match) return null;
	return {
		token: match[1] ?? "",
		rest: (match[2] ?? "").trim()
	};
}
function detectWindowsSpawnCommandInlineArgs(command) {
	const parsed = readCommandToken(command);
	if (!parsed?.rest) return null;
	const normalizedToken = parsed.token.replace(/\\/g, "/");
	const executable = normalizeLowercaseStringOrEmpty(path.posix.basename(normalizedToken));
	if (!INLINE_ARGUMENT_EXECUTABLES.has(executable)) return null;
	return {
		executable: parsed.token,
		arguments: parsed.rest
	};
}
/** Resolve a Windows command name through PATH and PATHEXT so wrapper inspection sees the real file. */
function resolveWindowsExecutablePath(command, env) {
	if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) return command;
	const pathEntries = (env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? "").split(";").map((entry) => entry.trim()).filter(Boolean);
	const hasExtension = path.extname(command).length > 0;
	const pathExtRaw = env.PATHEXT ?? env.Pathext ?? process.env.PATHEXT ?? process.env.Pathext ?? ".EXE;.CMD;.BAT;.COM";
	const pathExt = hasExtension ? [""] : pathExtRaw.split(";").map((ext) => ext.trim()).filter(Boolean).map((ext) => ext.startsWith(".") ? ext : `.${ext}`);
	for (const dir of pathEntries) for (const ext of pathExt) {
		const normalizedExt = normalizeLowercaseStringOrEmpty(ext);
		const uppercaseExt = ext.toUpperCase();
		for (const candidateExt of [
			ext,
			normalizedExt,
			uppercaseExt
		]) {
			const candidate = path.join(dir, `${command}${candidateExt}`);
			if (isFilePath(candidate)) return candidate;
		}
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
			const base = normalizeLowercaseStringOrEmpty(path.basename(candidate));
			return base !== "node.exe" && base !== "node";
		}) ?? null;
	} catch {
		return null;
	}
}
function resolveBinEntry(packageName, binField) {
	if (typeof binField === "string") return normalizeOptionalString(binField) || null;
	if (!binField || typeof binField !== "object") return null;
	if (packageName) {
		const preferred = binField[packageName];
		const normalizedPreferred = typeof preferred === "string" ? normalizeOptionalString(preferred) : void 0;
		if (normalizedPreferred) return normalizedPreferred;
	}
	for (const value of Object.values(binField)) {
		const normalizedValue = typeof value === "string" ? normalizeOptionalString(value) : void 0;
		if (normalizedValue) return normalizedValue;
	}
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
/** Resolve the safest direct spawn candidate for Windows wrappers, scripts, and binaries. */
function resolveWindowsSpawnProgramCandidate(params) {
	const platform = params.platform ?? process.platform;
	const env = params.env ?? process.env;
	const execPath = params.execPath ?? process.execPath;
	if (platform !== "win32") return {
		command: params.command,
		leadingArgv: [],
		resolution: "direct"
	};
	const inlineArgs = detectWindowsSpawnCommandInlineArgs(params.command);
	if (inlineArgs) throw new Error(`Windows spawn command must be an executable path only; "${inlineArgs.executable}" was configured with inline arguments "${inlineArgs.arguments}". Put arguments in the caller's args array instead.`);
	const resolvedCommand = resolveWindowsExecutablePath(params.command, env);
	const ext = normalizeLowercaseStringOrEmpty(path.extname(resolvedCommand));
	if (ext === ".js" || ext === ".cjs" || ext === ".mjs") return {
		command: execPath,
		leadingArgv: [resolvedCommand],
		resolution: "node-entrypoint",
		windowsHide: true
	};
	if (ext === ".cmd" || ext === ".bat") {
		const entrypoint = resolveEntrypointFromCmdShim(resolvedCommand) ?? resolveEntrypointFromPackageJson(resolvedCommand, params.packageName);
		if (entrypoint) {
			if (normalizeLowercaseStringOrEmpty(path.extname(entrypoint)) === ".exe") return {
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
/** Apply shell-fallback policy when Windows wrapper resolution could not find a direct entrypoint. */
function applyWindowsSpawnProgramPolicy(params) {
	if (params.candidate.resolution !== "unresolved-wrapper") return {
		command: params.candidate.command,
		leadingArgv: params.candidate.leadingArgv,
		resolution: params.candidate.resolution,
		windowsHide: params.candidate.windowsHide
	};
	if (params.allowShellFallback === true) return {
		command: params.candidate.command,
		leadingArgv: [],
		resolution: "shell-fallback",
		shell: true
	};
	throw new Error(`${path.basename(params.candidate.command)} wrapper resolved, but no executable/Node entrypoint could be resolved without shell execution.`);
}
/** Resolve the final Windows spawn program after candidate discovery and fallback policy. */
function resolveWindowsSpawnProgram(params) {
	return applyWindowsSpawnProgramPolicy({
		candidate: resolveWindowsSpawnProgramCandidate(params),
		allowShellFallback: params.allowShellFallback
	});
}
/** Combine a resolved Windows spawn program with call-site argv for actual process launch. */
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
export { resolveWindowsSpawnProgram as a, resolveWindowsExecutablePath as i, detectWindowsSpawnCommandInlineArgs as n, resolveWindowsSpawnProgramCandidate as o, materializeWindowsSpawnProgram as r, applyWindowsSpawnProgramPolicy as t };
