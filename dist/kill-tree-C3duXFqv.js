import { spawn } from "node:child_process";
//#region src/process/kill-tree.ts
const DEFAULT_GRACE_MS = 3e3;
const MAX_GRACE_MS = 6e4;
/**
* Best-effort process-tree termination with graceful shutdown.
* - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
*   first (without /F), then force-kills if process survives.
* - Unix: send SIGTERM to process group first, wait grace period, then SIGKILL.
*
* This gives child processes a chance to clean up (close connections, remove
* temp files, terminate their own children) before being hard-killed.
*
* When the child was spawned with `detached: false` (e.g. service-managed
* runtime under launchd/systemd), pass `detached: false` to skip the Unix
* `process.kill(-pid, ...)` group-kill — it would otherwise target the
* gateway's own process group and SIGTERM the gateway itself. (#71662)
*/
function killProcessTree(pid, opts) {
	if (!Number.isFinite(pid) || pid <= 0) return;
	const graceMs = normalizeGraceMs(opts?.graceMs);
	if (process.platform === "win32") {
		killProcessTreeWindows(pid, graceMs);
		return;
	}
	killProcessTreeUnix(pid, graceMs, opts?.detached !== false);
}
function normalizeGraceMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_GRACE_MS;
	return Math.max(0, Math.min(MAX_GRACE_MS, Math.floor(value)));
}
function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function killProcessTreeUnix(pid, graceMs, useGroupKill) {
	if (useGroupKill) try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return;
		}
	}
	else try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	setTimeout(() => {
		if (useGroupKill && isProcessAlive(-pid)) try {
			process.kill(-pid, "SIGKILL");
			return;
		} catch {}
		if (!isProcessAlive(pid)) return;
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}, graceMs).unref();
}
function runTaskkill(args) {
	try {
		spawn("taskkill", args, {
			stdio: "ignore",
			detached: true,
			windowsHide: true
		});
	} catch {}
}
function killProcessTreeWindows(pid, graceMs) {
	runTaskkill([
		"/T",
		"/PID",
		String(pid)
	]);
	setTimeout(() => {
		if (!isProcessAlive(pid)) return;
		runTaskkill([
			"/F",
			"/T",
			"/PID",
			String(pid)
		]);
	}, graceMs).unref();
}
//#endregion
export { killProcessTree as t };
