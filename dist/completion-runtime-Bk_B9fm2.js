import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { u as pathExists } from "./utils-sBTEdeml.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region src/cli/completion-runtime.ts
const COMPLETION_SHELLS = [
	"zsh",
	"bash",
	"powershell",
	"fish"
];
const COMPLETION_SKIP_PLUGIN_COMMANDS_ENV = "OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS";
function isCompletionShell(value) {
	return COMPLETION_SHELLS.includes(value);
}
function resolveShellBasename(shellPath, platform = process.platform) {
	const platformBasename = platform === "win32" ? path.win32.basename(shellPath) : path.basename(shellPath);
	const winBasename = path.win32.basename(shellPath);
	return normalizeLowercaseStringOrEmpty((winBasename.length < platformBasename.length ? winBasename : platformBasename).replace(/\.(?:exe|cmd|bat)$/i, ""));
}
function resolveShellFromEnv(env = process.env) {
	const shellPath = normalizeOptionalString(env.SHELL) ?? "";
	const shellName = shellPath ? resolveShellBasename(shellPath) : "";
	if (shellName === "zsh") return "zsh";
	if (shellName === "bash") return "bash";
	if (shellName === "fish") return "fish";
	if (shellName === "pwsh" || shellName === "powershell") return "powershell";
	return "zsh";
}
function sanitizeCompletionBasename(value) {
	const trimmed = value.trim();
	if (!trimmed) return "openclaw";
	return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}
function resolveCompletionCacheDir(env = process.env) {
	const stateDir = resolveStateDir(env, os.homedir);
	return path.join(stateDir, "completions");
}
function resolveCompletionCachePath(shell, binName) {
	const basename = sanitizeCompletionBasename(binName);
	const extension = shell === "powershell" ? "ps1" : shell === "fish" ? "fish" : shell === "bash" ? "bash" : "zsh";
	return path.join(resolveCompletionCacheDir(), `${basename}.${extension}`);
}
/** Check if the completion cache file exists for the given shell. */
async function completionCacheExists(shell, binName = "openclaw") {
	return pathExists(resolveCompletionCachePath(shell, binName));
}
function escapePowerShellSingleQuotedString(value) {
	return value.replace(/'/g, "''");
}
function formatCompletionSourceLine(shell, _binName, cachePath) {
	if (shell === "powershell") return `. '${escapePowerShellSingleQuotedString(cachePath)}'`;
	if (shell === "fish") return `test -f "${cachePath}"; and source "${cachePath}"`;
	return `[ -f "${cachePath}" ] && source "${cachePath}"`;
}
function formatCompletionReloadCommand(shell, profilePath) {
	if (shell === "powershell") return `. '${escapePowerShellSingleQuotedString(profilePath)}'`;
	return `source ${profilePath}`;
}
function isCompletionProfileHeader(line) {
	return line.trim() === "# OpenClaw Completion";
}
function isCompletionProfileLine(line, binName, cachePath) {
	if (line.includes(`${binName} completion`)) return true;
	if (cachePath && line.includes(cachePath)) return true;
	return false;
}
/** Check if a line uses the slow dynamic completion pattern (source <(...)) */
function isSlowDynamicCompletionLine(line, binName) {
	return line.includes(`<(${binName} completion`) || line.includes(`${binName} completion`) && line.includes("| source");
}
function updateCompletionProfile(content, binName, cachePath, sourceLine) {
	const lines = content.split("\n");
	const filtered = [];
	let hadExisting = false;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (isCompletionProfileHeader(line)) {
			hadExisting = true;
			i += 1;
			continue;
		}
		if (isCompletionProfileLine(line, binName, cachePath)) {
			hadExisting = true;
			continue;
		}
		filtered.push(line);
	}
	const trimmed = filtered.join("\n").trimEnd();
	const block = `# OpenClaw Completion\n${sourceLine}`;
	const next = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
	return {
		next,
		changed: next !== content,
		hadExisting
	};
}
function resolveCompletionProfilePath(shell, options = {}) {
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? os.homedir;
	const platform = options.platform ?? process.platform;
	const home = env.HOME || homeDir();
	if (shell === "zsh") return path.join(home, ".zshrc");
	if (shell === "bash") return path.join(home, ".bashrc");
	if (shell === "fish") return path.join(home, ".config", "fish", "config.fish");
	if (platform === "win32") {
		const shellPath = normalizeOptionalString(env.SHELL) ?? "";
		const profileDirectory = (shellPath ? resolveShellBasename(shellPath, platform) : "") === "powershell" ? "WindowsPowerShell" : "PowerShell";
		return path.win32.join(env.USERPROFILE || home, "Documents", profileDirectory, "Microsoft.PowerShell_profile.ps1");
	}
	return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
}
async function isCompletionInstalled(shell, binName = "openclaw") {
	const profilePath = resolveCompletionProfilePath(shell);
	if (!await pathExists(profilePath)) return false;
	const cachePathCandidate = resolveCompletionCachePath(shell, binName);
	const cachedPath = await pathExists(cachePathCandidate) ? cachePathCandidate : null;
	return (await fs.readFile(profilePath, "utf-8")).split("\n").some((line) => isCompletionProfileHeader(line) || isCompletionProfileLine(line, binName, cachedPath));
}
/**
* Check if the profile uses the slow dynamic completion pattern.
* Returns true if profile has `source <(openclaw completion ...)` instead of cached file.
*/
async function usesSlowDynamicCompletion(shell, binName = "openclaw") {
	const profilePath = resolveCompletionProfilePath(shell);
	if (!await pathExists(profilePath)) return false;
	const cachePath = resolveCompletionCachePath(shell, binName);
	const lines = (await fs.readFile(profilePath, "utf-8")).split("\n");
	for (const line of lines) if (isSlowDynamicCompletionLine(line, binName) && !line.includes(cachePath)) return true;
	return false;
}
async function installCompletion(shell, yes, binName = "openclaw") {
	if (!isCompletionShell(shell)) {
		console.error(`Automated installation not supported for ${shell} yet.`);
		return;
	}
	const cachePath = resolveCompletionCachePath(shell, binName);
	if (!await pathExists(cachePath)) {
		console.error(`Completion cache not found at ${cachePath}. Run \`${binName} completion --write-state\` first.`);
		return;
	}
	let profilePath;
	let sourceLine;
	switch (shell) {
		case "zsh":
			profilePath = resolveCompletionProfilePath("zsh");
			sourceLine = formatCompletionSourceLine("zsh", binName, cachePath);
			break;
		case "bash":
			profilePath = resolveCompletionProfilePath("bash");
			try {
				await fs.access(profilePath);
			} catch {
				const home = process.env.HOME || os.homedir();
				profilePath = path.join(home, ".bash_profile");
			}
			sourceLine = formatCompletionSourceLine("bash", binName, cachePath);
			break;
		case "fish":
			profilePath = resolveCompletionProfilePath("fish");
			sourceLine = formatCompletionSourceLine("fish", binName, cachePath);
			break;
		case "powershell":
			profilePath = resolveCompletionProfilePath("powershell");
			sourceLine = formatCompletionSourceLine("powershell", binName, cachePath);
			break;
	}
	try {
		try {
			await fs.access(profilePath);
		} catch {
			if (!yes) console.warn(`Profile not found at ${profilePath}. Created a new one.`);
			await fs.mkdir(path.dirname(profilePath), { recursive: true });
			await fs.writeFile(profilePath, "", "utf-8");
		}
		const update = updateCompletionProfile(await fs.readFile(profilePath, "utf-8"), binName, cachePath, sourceLine);
		if (!update.changed) {
			if (!yes) console.log(`Completion already installed in ${profilePath}`);
			return;
		}
		if (!yes) {
			const action = update.hadExisting ? "Updating" : "Installing";
			console.log(`${action} completion in ${profilePath}...`);
		}
		await fs.writeFile(profilePath, update.next, "utf-8");
		if (!yes) console.log(`Completion installed. Restart your shell or run: ${formatCompletionReloadCommand(shell, profilePath)}`);
	} catch (err) {
		console.error(`Failed to install completion: ${err}`);
	}
}
//#endregion
export { installCompletion as a, resolveCompletionCachePath as c, usesSlowDynamicCompletion as d, formatCompletionReloadCommand as i, resolveCompletionProfilePath as l, COMPLETION_SKIP_PLUGIN_COMMANDS_ENV as n, isCompletionInstalled as o, completionCacheExists as r, isCompletionShell as s, COMPLETION_SHELLS as t, resolveShellFromEnv as u };
