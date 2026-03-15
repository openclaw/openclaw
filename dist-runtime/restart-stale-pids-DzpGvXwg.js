import { u as resolveGatewayPort } from "./paths-1qR_mW4i.js";
import { t as createSubsystemLogger } from "./subsystem-EnljYYs1.js";
import { n as resolveLsofCommandSync } from "./ports-lsof-CCbcofNf.js";
import { spawnSync } from "node:child_process";
//#region src/infra/restart-stale-pids.ts
const SPAWN_TIMEOUT_MS = 2e3;
const STALE_SIGTERM_WAIT_MS = 600;
const STALE_SIGKILL_WAIT_MS = 400;
/**
* After SIGKILL, the kernel may not release the TCP port immediately.
* Poll until the port is confirmed free (or until the budget expires) before
* returning control to the caller (typically `triggerOpenClawRestart` →
* `systemctl restart`). Without this wait the new process races the dying
* process for the port and systemd enters an EADDRINUSE restart loop.
*
* POLL_SPAWN_TIMEOUT_MS is intentionally much shorter than SPAWN_TIMEOUT_MS
* so that a single slow or hung lsof invocation does not consume the entire
* polling budget. At 400 ms per call, up to five independent lsof attempts
* fit within PORT_FREE_TIMEOUT_MS = 2000 ms, each with a definitive outcome.
*/
const PORT_FREE_POLL_INTERVAL_MS = 50;
const PORT_FREE_TIMEOUT_MS = 2e3;
const POLL_SPAWN_TIMEOUT_MS = 400;
const restartLog = createSubsystemLogger("restart");
function getTimeMs() {
	return Date.now();
}
function sleepSync(ms) {
	const timeoutMs = Math.max(0, Math.floor(ms));
	if (timeoutMs <= 0) {return;}
	try {
		const lock = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(lock, 0, 0, timeoutMs);
	} catch {
		const start = Date.now();
		while (Date.now() - start < timeoutMs){;}
	}
}
/**
* Parse openclaw gateway PIDs from lsof -Fpc stdout.
* Pure function — no I/O. Excludes the current process.
*/
function parsePidsFromLsofOutput(stdout) {
	const pids = [];
	let currentPid;
	let currentCmd;
	for (const line of stdout.split(/\r?\n/).filter(Boolean)) {if (line.startsWith("p")) {
		if (currentPid != null && currentCmd && currentCmd.toLowerCase().includes("openclaw")) pids.push(currentPid);
		const parsed = Number.parseInt(line.slice(1), 10);
		currentPid = Number.isFinite(parsed) && parsed > 0 ? parsed : void 0;
		currentCmd = void 0;
	} else if (line.startsWith("c")) currentCmd = line.slice(1);}
	if (currentPid != null && currentCmd && currentCmd.toLowerCase().includes("openclaw")) {pids.push(currentPid);}
	return [...new Set(pids)].filter((pid) => pid !== process.pid);
}
/**
* Find PIDs of gateway processes listening on the given port using synchronous lsof.
* Returns only PIDs that belong to openclaw gateway processes (not the current process).
*/
function findGatewayPidsOnPortSync(port, spawnTimeoutMs = SPAWN_TIMEOUT_MS) {
	if (process.platform === "win32") {return [];}
	const res = spawnSync(resolveLsofCommandSync(), [
		"-nP",
		`-iTCP:${port}`,
		"-sTCP:LISTEN",
		"-Fpc"
	], {
		encoding: "utf8",
		timeout: spawnTimeoutMs
	});
	if (res.error) {
		const code = res.error.code;
		const detail = code && code.trim().length > 0 ? code : res.error instanceof Error ? res.error.message : "unknown error";
		restartLog.warn(`lsof failed during initial stale-pid scan for port ${port}: ${detail}`);
		return [];
	}
	if (res.status === 1) {return [];}
	if (res.status !== 0) {
		restartLog.warn(`lsof exited with status ${res.status} during initial stale-pid scan for port ${port}; skipping stale pid check`);
		return [];
	}
	return parsePidsFromLsofOutput(res.stdout);
}
function pollPortOnce(port) {
	try {
		const res = spawnSync(resolveLsofCommandSync(), [
			"-nP",
			`-iTCP:${port}`,
			"-sTCP:LISTEN",
			"-Fpc"
		], {
			encoding: "utf8",
			timeout: POLL_SPAWN_TIMEOUT_MS
		});
		if (res.error) {
			const code = res.error.code;
			return {
				free: null,
				permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM"
			};
		}
		if (res.status === 1) {
			if (res.stdout) {return parsePidsFromLsofOutput(res.stdout).length === 0 ? { free: true } : { free: false };}
			return { free: true };
		}
		if (res.status !== 0) {return {
			free: null,
			permanent: false
		};}
		return parsePidsFromLsofOutput(res.stdout).length === 0 ? { free: true } : { free: false };
	} catch {
		return {
			free: null,
			permanent: false
		};
	}
}
/**
* Synchronously terminate stale gateway processes.
* Callers must pass a non-empty pids array.
* Sends SIGTERM, waits briefly, then SIGKILL for survivors.
*/
function terminateStaleProcessesSync(pids) {
	const killed = [];
	for (const pid of pids) {try {
		process.kill(pid, "SIGTERM");
		killed.push(pid);
	} catch {}}
	if (killed.length === 0) {return killed;}
	sleepSync(STALE_SIGTERM_WAIT_MS);
	for (const pid of killed) {try {
		process.kill(pid, 0);
		process.kill(pid, "SIGKILL");
	} catch {}}
	sleepSync(STALE_SIGKILL_WAIT_MS);
	return killed;
}
/**
* Poll the given port until it is confirmed free, lsof is confirmed unavailable,
* or the wall-clock budget expires.
*
* Each poll invocation uses POLL_SPAWN_TIMEOUT_MS (400 ms), which is
* significantly shorter than PORT_FREE_TIMEOUT_MS (2000 ms). This ensures
* that a single slow or hung lsof call cannot consume the entire polling
* budget and cause the function to exit prematurely with an inconclusive
* result. Up to five independent lsof attempts fit within the budget.
*
* Exit conditions:
*   - `pollPortOnce` returns `{ free: true }`                    → port confirmed free
*   - `pollPortOnce` returns `{ free: null, permanent: true }`   → lsof unavailable, bail
*   - `pollPortOnce` returns `{ free: false }`                   → port busy, sleep + retry
*   - `pollPortOnce` returns `{ free: null, permanent: false }`  → transient error, sleep + retry
*   - Wall-clock deadline exceeded                               → log warning, proceed anyway
*/
function waitForPortFreeSync(port) {
	const deadline = getTimeMs() + PORT_FREE_TIMEOUT_MS;
	while (getTimeMs() < deadline) {
		const result = pollPortOnce(port);
		if (result.free === true) {return;}
		if (result.free === null && result.permanent) {return;}
		sleepSync(PORT_FREE_POLL_INTERVAL_MS);
	}
	restartLog.warn(`port ${port} still in use after ${PORT_FREE_TIMEOUT_MS}ms; proceeding anyway`);
}
/**
* Inspect the gateway port and kill any stale gateway processes holding it.
* Blocks until the port is confirmed free (or the poll budget expires) so
* the supervisor (systemd / launchctl) does not race a zombie process for
* the port and enter an EADDRINUSE restart loop.
*
* Called before service restart commands to prevent port conflicts.
*/
function cleanStaleGatewayProcessesSync(portOverride) {
	try {
		const port = typeof portOverride === "number" && Number.isFinite(portOverride) && portOverride > 0 ? Math.floor(portOverride) : resolveGatewayPort(void 0, process.env);
		const stalePids = findGatewayPidsOnPortSync(port);
		if (stalePids.length === 0) {return [];}
		restartLog.warn(`killing ${stalePids.length} stale gateway process(es) before restart: ${stalePids.join(", ")}`);
		const killed = terminateStaleProcessesSync(stalePids);
		waitForPortFreeSync(port);
		return killed;
	} catch {
		return [];
	}
}
//#endregion
export { findGatewayPidsOnPortSync as n, cleanStaleGatewayProcessesSync as t };
