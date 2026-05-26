//#region src/infra/supervisor-markers.ts
const SUPERVISOR_HINTS = {
	launchd: [
		"LAUNCH_JOB_LABEL",
		"LAUNCH_JOB_NAME",
		"XPC_SERVICE_NAME",
		"OPENCLAW_LAUNCHD_LABEL"
	],
	systemd: [
		"OPENCLAW_SYSTEMD_UNIT",
		"INVOCATION_ID",
		"SYSTEMD_EXEC_PID",
		"JOURNAL_STREAM"
	],
	schtasks: ["OPENCLAW_WINDOWS_TASK_NAME"]
};
const SUPERVISOR_HINT_ENV_VARS = [
	...SUPERVISOR_HINTS.launchd,
	...SUPERVISOR_HINTS.systemd,
	...SUPERVISOR_HINTS.schtasks,
	"OPENCLAW_SERVICE_MARKER",
	"OPENCLAW_SERVICE_KIND"
];
function hasAnyHint(env, keys) {
	return keys.some((key) => {
		const value = env[key];
		return typeof value === "string" && value.trim().length > 0;
	});
}
function detectRespawnSupervisor(env = process.env, platform = process.platform) {
	if (platform === "darwin") return hasAnyHint(env, SUPERVISOR_HINTS.launchd) ? "launchd" : null;
	if (platform === "linux") return hasAnyHint(env, SUPERVISOR_HINTS.systemd) ? "systemd" : null;
	if (platform === "win32") {
		if (hasAnyHint(env, SUPERVISOR_HINTS.schtasks)) return "schtasks";
		const marker = env.OPENCLAW_SERVICE_MARKER?.trim();
		const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
		return marker && serviceKind === "gateway" ? "schtasks" : null;
	}
	return null;
}
//#endregion
export { detectRespawnSupervisor as n, SUPERVISOR_HINT_ENV_VARS as t };
