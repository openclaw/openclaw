import fs from "node:fs";
import path from "node:path";
//#region src/agents/shell-utils.ts
function resolvePowerShellPath() {
	const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files";
	const pwsh7 = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
	if (fs.existsSync(pwsh7)) return pwsh7;
	const programW6432 = process.env.ProgramW6432;
	if (programW6432 && programW6432 !== programFiles) {
		const pwsh7Alt = path.join(programW6432, "PowerShell", "7", "pwsh.exe");
		if (fs.existsSync(pwsh7Alt)) return pwsh7Alt;
	}
	const pwshInPath = resolveShellFromPath("pwsh");
	if (pwshInPath) return pwshInPath;
	const systemRoot = process.env.SystemRoot || process.env.WINDIR;
	if (systemRoot) {
		const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		if (fs.existsSync(candidate)) return candidate;
	}
	return "powershell.exe";
}
const NON_INTERACTIVE_SHELLS = new Set(["false", "nologin"]);
function isNonInteractiveShell(shellPath) {
	if (!shellPath) return false;
	return NON_INTERACTIVE_SHELLS.has(path.basename(shellPath));
}
function getPosixShellArgs(shellPath) {
	switch (path.basename(shellPath)) {
		case "bash": return [
			"--noprofile",
			"--norc",
			"-c"
		];
		case "zsh": return ["-f", "-c"];
		case "fish": return ["--no-config", "-c"];
		default: return ["-c"];
	}
}
function getShellConfig() {
	if (process.platform === "win32") return {
		shell: resolvePowerShellPath(),
		args: [
			"-NoProfile",
			"-NonInteractive",
			"-Command"
		]
	};
	const rawEnvShell = process.env.SHELL?.trim();
	const envShell = rawEnvShell && !isNonInteractiveShell(rawEnvShell) ? rawEnvShell : void 0;
	if ((envShell ? path.basename(envShell) : "") === "fish") {
		const bash = resolveShellFromPath("bash");
		if (bash) return {
			shell: bash,
			args: getPosixShellArgs(bash)
		};
		const sh = resolveShellFromPath("sh");
		if (sh) return {
			shell: sh,
			args: getPosixShellArgs(sh)
		};
	}
	if (envShell) return {
		shell: envShell,
		args: getPosixShellArgs(envShell)
	};
	const shell = resolveShellFromPath("sh") ?? resolveShellFromPath("bash") ?? "sh";
	return {
		shell,
		args: getPosixShellArgs(shell)
	};
}
function resolveShellFromPath(name) {
	const envPath = process.env.PATH ?? "";
	if (!envPath) return;
	const entries = envPath.split(path.delimiter).filter(Boolean);
	for (const entry of entries) {
		const candidate = path.join(entry, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {}
	}
}
function normalizeShellName(value) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return path.basename(trimmed).replace(/\.(exe|cmd|bat)$/i, "").replace(/[^a-zA-Z0-9_-]/g, "");
}
function detectRuntimeShell() {
	const overrideShell = process.env.OPENCLAW_SHELL?.trim();
	if (overrideShell) {
		const name = normalizeShellName(overrideShell);
		if (name) return name;
	}
	if (process.platform === "win32") {
		if (process.env.POWERSHELL_DISTRIBUTION_CHANNEL) return "pwsh";
		return "powershell";
	}
	const envShell = process.env.SHELL?.trim();
	if (envShell && !isNonInteractiveShell(envShell)) {
		const name = normalizeShellName(envShell);
		if (name) return name;
	}
	if (process.env.POWERSHELL_DISTRIBUTION_CHANNEL) return "pwsh";
	if (process.env.BASH_VERSION) return "bash";
	if (process.env.ZSH_VERSION) return "zsh";
	if (process.env.FISH_VERSION) return "fish";
	if (process.env.KSH_VERSION) return "ksh";
	if (process.env.NU_VERSION || process.env.NUSHELL_VERSION) return "nu";
}
function sanitizeBinaryOutput(text) {
	const scrubbed = text.replace(/[\p{Format}\p{Surrogate}]/gu, "");
	if (!scrubbed) return scrubbed;
	const chunks = [];
	for (const char of scrubbed) {
		const code = char.codePointAt(0);
		if (code == null) continue;
		if (code === 9 || code === 10 || code === 13) {
			chunks.push(char);
			continue;
		}
		if (code < 32) continue;
		chunks.push(char);
	}
	return chunks.join("");
}
//#endregion
export { getShellConfig as n, sanitizeBinaryOutput as r, detectRuntimeShell as t };
