import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { m as classifySystemdUnavailableDetail } from "./systemd-DsQkjgIm.js";
import { a as resolveGatewaySupervisorLogPaths, i as resolveGatewayRestartLogPath } from "./restart-logs-DA9VPiFu.js";
import { r as toPosixPath } from "./runtime-parse-kPUd4M9k.js";
import { t as formatRuntimeStatusWithDetails } from "./runtime-status-Bg5sKikV.js";
//#region src/daemon/systemd-hints.ts
function isSystemdUnavailableDetail(detail) {
	return classifySystemdUnavailableDetail(detail) !== null;
}
function renderSystemdHeadlessServerHints() {
	return ["On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.", "Also ensure XDG_RUNTIME_DIR is set: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, then retry."];
}
function renderSystemdUnavailableHints(options = {}) {
	if (options.wsl) return [
		"WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
		"Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
		"Verify: systemctl --user status"
	];
	return [
		"systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
		...options.container || options.kind !== "user_bus_unavailable" ? [] : renderSystemdHeadlessServerHints(),
		`If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`
	];
}
//#endregion
//#region src/daemon/container-context.ts
function resolveDaemonContainerContext(env = process.env) {
	return normalizeOptionalString(env.OPENCLAW_CONTAINER_HINT) || normalizeOptionalString(env.OPENCLAW_CONTAINER) || null;
}
//#endregion
//#region src/daemon/runtime-format.ts
const SIGNAL_NAMES_BY_STATUS = new Map([
	[129, "SIGHUP"],
	[130, "SIGINT"],
	[131, "SIGQUIT"],
	[134, "SIGABRT/abort"],
	[137, "SIGKILL"],
	[143, "SIGTERM"]
]);
function formatLastExitStatus(status) {
	const signalName = SIGNAL_NAMES_BY_STATUS.get(status);
	return signalName ? `last exit ${status} (${signalName})` : `last exit ${status}`;
}
function formatRuntimeStatus(runtime) {
	if (!runtime) return null;
	const details = [];
	if (runtime.subState) details.push(`sub ${runtime.subState}`);
	if (runtime.lastExitStatus !== void 0) details.push(formatLastExitStatus(runtime.lastExitStatus));
	if (runtime.lastExitReason) details.push(`reason ${runtime.lastExitReason}`);
	if (runtime.lastRunResult) details.push(`last run ${runtime.lastRunResult}`);
	if (runtime.lastRunTime) details.push(`last run time ${runtime.lastRunTime}`);
	if (runtime.detail) details.push(runtime.detail);
	return formatRuntimeStatusWithDetails({
		status: runtime.status,
		pid: runtime.pid,
		state: runtime.state,
		details
	});
}
//#endregion
//#region src/daemon/runtime-hints.ts
function toDarwinDisplayPath(value) {
	return toPosixPath(value).replace(/^[A-Za-z]:/, "");
}
function buildPlatformRuntimeLogHints(params) {
	const platform = params.platform ?? process.platform;
	const env = {
		...process.env,
		...params.env
	};
	if (platform === "darwin") return [
		`Launchd stdout (if installed): ${toDarwinDisplayPath(resolveGatewaySupervisorLogPaths(env, { platform }).stdoutPath)}`,
		"Launchd stderr (if installed): suppressed",
		`Restart attempts: ${toDarwinDisplayPath(resolveGatewayRestartLogPath(env))}`
	];
	if (platform === "linux") return [`Logs: journalctl --user -u ${params.systemdServiceName}.service -n 200 --no-pager`, `Restart attempts: ${resolveGatewayRestartLogPath(env)}`];
	if (platform === "win32") return [`Logs: schtasks /Query /TN "${params.windowsTaskName}" /V /FO LIST`, `Restart attempts: ${resolveGatewayRestartLogPath(env)}`];
	return [];
}
function buildPlatformServiceStartHints(params) {
	const platform = params.platform ?? process.platform;
	const base = [params.installCommand, params.startCommand];
	switch (platform) {
		case "darwin": return [...base, `launchctl bootstrap gui/$UID ${params.launchAgentPlistPath}`];
		case "linux": return [...base, `systemctl --user start ${params.systemdServiceName}.service`];
		case "win32": return [...base, `schtasks /Run /TN "${params.windowsTaskName}"`];
		default: return base;
	}
}
//#endregion
export { isSystemdUnavailableDetail as a, resolveDaemonContainerContext as i, buildPlatformServiceStartHints as n, renderSystemdUnavailableHints as o, formatRuntimeStatus as r, buildPlatformRuntimeLogHints as t };
