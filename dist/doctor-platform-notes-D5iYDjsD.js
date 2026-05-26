import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { r as findStaleOpenClawUpdateLaunchdJobs } from "./launchd-CTjF-v1R.js";
import { t as note } from "./note-Dg2Luaaq.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/commands/doctor-platform-notes.ts
const execFileAsync = promisify(execFile);
function resolveHomeDir() {
	return process.env.HOME ?? os.homedir();
}
function collectMacLaunchAgentOverrideWarning(deps) {
	if ((deps?.platform ?? process.platform) !== "darwin") return null;
	const home = deps?.homeDir ?? resolveHomeDir();
	const markerCandidates = [path.join(home, ".openclaw", "disable-launchagent")];
	const exists = deps?.exists ?? fs.existsSync;
	const markerPath = markerCandidates.find((candidate) => exists(candidate));
	if (!markerPath) return null;
	const displayMarkerPath = shortenHomePath(markerPath);
	return [
		`- LaunchAgent writes are disabled via ${displayMarkerPath}.`,
		"- To restore default behavior:",
		`  rm ${displayMarkerPath}`
	].join("\n");
}
async function noteMacLaunchAgentOverrides() {
	const warning = collectMacLaunchAgentOverrideWarning();
	if (warning) note(warning, "Gateway (macOS)");
}
async function collectMacStaleOpenClawUpdateLaunchdJobsWarning(deps) {
	if ((deps?.platform ?? process.platform) !== "darwin") return null;
	const jobs = await (deps?.findJobs ?? findStaleOpenClawUpdateLaunchdJobs)().catch(() => []);
	if (jobs.length === 0) return null;
	return [
		"- Stale OpenClaw updater launchd job(s) detected.",
		...jobs.map((job) => {
			const exitStatus = job.lastExitStatus !== void 0 ? `, last exit ${job.lastExitStatus}` : "";
			const pid = job.pid !== void 0 ? `, pid ${job.pid}` : "";
			return `- ${job.label}${pid}${exitStatus}`;
		}),
		"- Fix after confirming no update is running:",
		"  launchctl remove <label>",
		`  ${formatCliCommand("openclaw gateway restart")}`
	].join("\n");
}
async function noteMacStaleOpenClawUpdateLaunchdJobs(deps) {
	const warning = await collectMacStaleOpenClawUpdateLaunchdJobsWarning(deps);
	if (warning) (deps?.noteFn ?? note)(warning, "Gateway (macOS)");
}
async function launchctlGetenv(name) {
	try {
		const value = normalizeOptionalString((await execFileAsync("/bin/launchctl", ["getenv", name], { encoding: "utf8" })).stdout ?? "") ?? "";
		return value.length > 0 ? value : void 0;
	} catch {
		return;
	}
}
function hasConfigGatewayCreds(cfg) {
	const localPassword = cfg.gateway?.auth?.password;
	const remoteToken = cfg.gateway?.remote?.token;
	const remotePassword = cfg.gateway?.remote?.password;
	return hasConfiguredSecretInput(cfg.gateway?.auth?.token, cfg.secrets?.defaults) || hasConfiguredSecretInput(localPassword, cfg.secrets?.defaults) || hasConfiguredSecretInput(remoteToken, cfg.secrets?.defaults) || hasConfiguredSecretInput(remotePassword, cfg.secrets?.defaults);
}
async function collectMacLaunchctlGatewayEnvOverrideWarning(cfg, deps) {
	if ((deps?.platform ?? process.platform) !== "darwin") return null;
	if (!hasConfigGatewayCreds(cfg)) return null;
	const getenv = deps?.getenv ?? launchctlGetenv;
	const tokenEntries = [["OPENCLAW_GATEWAY_TOKEN", await getenv("OPENCLAW_GATEWAY_TOKEN")]];
	const passwordEntries = [["OPENCLAW_GATEWAY_PASSWORD", await getenv("OPENCLAW_GATEWAY_PASSWORD")]];
	const tokenEntry = tokenEntries.find(([, value]) => normalizeOptionalString(value));
	const passwordEntry = passwordEntries.find(([, value]) => normalizeOptionalString(value));
	const envToken = normalizeOptionalString(tokenEntry?.[1]) ?? "";
	const envPassword = normalizeOptionalString(passwordEntry?.[1]) ?? "";
	const envTokenKey = tokenEntry?.[0];
	const envPasswordKey = passwordEntry?.[0];
	if (!envToken && !envPassword) return null;
	return [
		"- Host-wide launchctl gateway auth overrides detected.",
		"- Current managed Gateway installs do not need these values unless config intentionally references the env var.",
		envToken && envTokenKey ? `- \`${envTokenKey}\` is set; it can make local clients use a different token than gateway.auth.token.` : void 0,
		envPassword ? `- \`${envPasswordKey ?? "OPENCLAW_GATEWAY_PASSWORD"}\` is set; it can make local clients use a different password than gateway.auth.password.` : void 0,
		"- Clear overrides and restart the app/gateway:",
		envTokenKey ? `  launchctl unsetenv ${envTokenKey}` : void 0,
		envPasswordKey ? `  launchctl unsetenv ${envPasswordKey}` : void 0
	].filter((line) => Boolean(line)).join("\n");
}
async function noteMacLaunchctlGatewayEnvOverrides(cfg, deps) {
	const warning = await collectMacLaunchctlGatewayEnvOverrideWarning(cfg, deps);
	if (warning) (deps?.noteFn ?? note)(warning, "Gateway (macOS)");
}
async function collectMacGatewayPlatformWarnings(cfg) {
	const warnings = [];
	const launchAgentWarning = collectMacLaunchAgentOverrideWarning();
	if (launchAgentWarning) warnings.push(launchAgentWarning);
	const staleUpdateWarning = await collectMacStaleOpenClawUpdateLaunchdJobsWarning();
	if (staleUpdateWarning) warnings.push(staleUpdateWarning);
	const launchctlWarning = await collectMacLaunchctlGatewayEnvOverrideWarning(cfg);
	if (launchctlWarning) warnings.push(launchctlWarning);
	return warnings;
}
function isTruthyEnvValue(value) {
	return Boolean(normalizeOptionalString(value));
}
function isTmpCompileCachePath(cachePath) {
	const normalized = cachePath.trim().replace(/\/+$/, "");
	return normalized === "/tmp" || normalized.startsWith("/tmp/") || normalized === "/private/tmp" || normalized.startsWith("/private/tmp/");
}
function noteStartupOptimizationHints(env = process.env, deps) {
	const platform = deps?.platform ?? process.platform;
	if (platform === "win32") return;
	const arch = deps?.arch ?? os.arch();
	const totalMemBytes = deps?.totalMemBytes ?? os.totalmem();
	if (!(platform === "linux" && (arch === "arm" || arch === "arm64" || platform === "linux" && totalMemBytes > 0 && totalMemBytes <= 8 * 1024 ** 3))) return;
	const noteFn = deps?.noteFn ?? note;
	const compileCache = normalizeOptionalString(env.NODE_COMPILE_CACHE) ?? "";
	const disableCompileCache = normalizeOptionalString(env.NODE_DISABLE_COMPILE_CACHE) ?? "";
	const noRespawn = normalizeOptionalString(env.OPENCLAW_NO_RESPAWN) ?? "";
	const lines = [];
	if (!compileCache) lines.push("- NODE_COMPILE_CACHE is not set; repeated CLI runs can be slower on small hosts (Pi/VM).");
	else if (isTmpCompileCachePath(compileCache)) lines.push("- NODE_COMPILE_CACHE points to /tmp; use /var/tmp so cache survives reboots and warms startup reliably.");
	if (isTruthyEnvValue(disableCompileCache)) lines.push("- NODE_DISABLE_COMPILE_CACHE is set; startup compile cache is disabled.");
	if (noRespawn !== "1") lines.push("- OPENCLAW_NO_RESPAWN is not set to 1; set it when you want routine gateway restarts to stay in-process instead of handing off to a managed supervisor.");
	if (lines.length === 0) return;
	const suggestions = [
		"- Suggested env for low-power hosts:",
		"  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
		"  mkdir -p /var/tmp/openclaw-compile-cache",
		"  export OPENCLAW_NO_RESPAWN=1",
		isTruthyEnvValue(disableCompileCache) ? "  unset NODE_DISABLE_COMPILE_CACHE" : void 0
	].filter((line) => Boolean(line));
	noteFn([...lines, ...suggestions].join("\n"), "Startup optimization");
}
//#endregion
export { collectMacGatewayPlatformWarnings, noteMacLaunchAgentOverrides, noteMacLaunchctlGatewayEnvOverrides, noteMacStaleOpenClawUpdateLaunchdJobs, noteStartupOptimizationHints };
