import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { d as resolveGatewayPort } from "./paths-Cw7f9XhU.js";
import { t as getWindowsInstallRoots } from "./windows-install-roots-C-V7Ai9d.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as resolveLsofCommandSync } from "./ports-lsof-BmdLddJi.js";
import { n as parseProcCmdline, t as isGatewayArgv } from "./gateway-process-argv-0KsxsGrA.js";
import { t as parseCmdScriptCommandLine } from "./cmd-argv-fj4pRVR6.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
//#region src/infra/windows-port-pids.ts
const DEFAULT_TIMEOUT_MS = 5e3;
function readListeningPidsViaPowerShell(port, timeoutMs) {
	const ps = spawnSync("powershell", [
		"-NoProfile",
		"-Command",
		`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`
	], {
		encoding: "utf8",
		timeout: timeoutMs,
		windowsHide: true
	});
	if (ps.error || ps.status !== 0) return null;
	return ps.stdout.split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter((pid) => Number.isFinite(pid) && pid > 0);
}
function parseListeningPidsFromNetstat(stdout, port) {
	const pids = /* @__PURE__ */ new Set();
	for (const line of stdout.split(/\r?\n/)) {
		const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
		if (!match) continue;
		const parsedPort = Number.parseInt(match[2] ?? "", 10);
		const pid = Number.parseInt(match[3] ?? "", 10);
		if (parsedPort === port && Number.isFinite(pid) && pid > 0) pids.add(pid);
	}
	return [...pids];
}
function readWindowsListeningPidsOnPortSync(port, timeoutMs = DEFAULT_TIMEOUT_MS) {
	const result = readWindowsListeningPidsResultSync(port, timeoutMs);
	return result.ok ? result.pids : [];
}
function readWindowsListeningPidsResultSync(port, timeoutMs = DEFAULT_TIMEOUT_MS) {
	const powershellPids = readListeningPidsViaPowerShell(port, timeoutMs);
	if (powershellPids != null) return {
		ok: true,
		pids: powershellPids
	};
	const netstat = spawnSync("netstat", [
		"-ano",
		"-p",
		"tcp"
	], {
		encoding: "utf8",
		timeout: timeoutMs,
		windowsHide: true
	});
	if (netstat.error) {
		const code = netstat.error.code;
		return {
			ok: false,
			permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM"
		};
	}
	if (netstat.status !== 0) return {
		ok: false,
		permanent: false
	};
	return {
		ok: true,
		pids: parseListeningPidsFromNetstat(netstat.stdout, port)
	};
}
function extractWindowsCommandLine(raw) {
	const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (const line of lines) {
		if (!normalizeLowercaseStringOrEmpty(line).startsWith("commandline=")) continue;
		return line.slice(12).trim() || null;
	}
	return lines.find((line) => normalizeLowercaseStringOrEmpty(line) !== "commandline") ?? null;
}
function readWindowsProcessArgsSync(pid, timeoutMs = DEFAULT_TIMEOUT_MS) {
	const result = readWindowsProcessArgsResultSync(pid, timeoutMs);
	return result.ok ? result.args : null;
}
function readWindowsProcessArgsResultSync(pid, timeoutMs = DEFAULT_TIMEOUT_MS) {
	const powershell = spawnSync("powershell", [
		"-NoProfile",
		"-Command",
		`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`
	], {
		encoding: "utf8",
		timeout: timeoutMs,
		windowsHide: true
	});
	if (!powershell.error && powershell.status === 0) {
		const command = powershell.stdout.trim();
		return {
			ok: true,
			args: command ? parseCmdScriptCommandLine(command) : null
		};
	}
	const wmic = spawnSync("wmic", [
		"process",
		"where",
		`ProcessId=${pid}`,
		"get",
		"CommandLine",
		"/value"
	], {
		encoding: "utf8",
		timeout: timeoutMs,
		windowsHide: true
	});
	if (!wmic.error && wmic.status === 0) {
		const command = extractWindowsCommandLine(wmic.stdout);
		return {
			ok: true,
			args: command ? parseCmdScriptCommandLine(command) : null
		};
	}
	const code = (wmic.error ?? powershell.error)?.code;
	return {
		ok: false,
		permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM"
	};
}
//#endregion
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
/**
* Upper bound on the ancestor-PID walk. A real-world chain is shallow
* (pid1 → systemd → gateway → plugin-host → sidecar ≈ 5); 32 generously covers
* nested-supervisor setups (k8s pod → containerd-shim → runc → …) while still
* providing a hard stop against corrupted process tables or ppid cycles.
*/
const MAX_ANCESTOR_WALK_DEPTH = 32;
const restartLog = createSubsystemLogger("restart");
function getTimeMs() {
	return Date.now();
}
function sleepSync(ms) {
	const timeoutMs = Math.max(0, Math.floor(ms));
	if (timeoutMs <= 0) return;
	try {
		const lock = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(lock, 0, 0, timeoutMs);
	} catch {
		const start = Date.now();
		while (Date.now() - start < timeoutMs);
	}
}
function getParentPid() {
	return process.ppid;
}
/**
* Read a single ancestor PID from `/proc/<pid>/status` on Linux.
* Returns null on any failure (non-Linux platform, restricted /proc, race
* where the target pid exited between the walk step and the read); callers
* treat a null return as "stop walking" and proceed with the ancestor set
* collected so far.
*/
function readParentPidFromProc(pid) {
	try {
		const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/^PPid:\s*(\d+)/m);
		if (!match) return null;
		const parsed = Number.parseInt(match[1] ?? "", 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	} catch {
		return null;
	}
}
function readParentPidFromPs(pid, spawnTimeoutMs) {
	try {
		const res = spawnSync("ps", [
			"-o",
			"ppid=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			timeout: spawnTimeoutMs
		});
		if (res.error || res.status !== 0 || !res.stdout.trim()) return null;
		const parsed = Number.parseInt(res.stdout.trim(), 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	} catch {
		return null;
	}
}
/**
* Collect the set of PIDs whose termination would cascade-kill the caller:
* the current process, its direct parent, and — where the platform permits
* — the full ancestor chain up to the top of the pid namespace.
*
* Rationale: `cleanStaleGatewayProcessesSync` already refuses to kill
* `process.pid` (see `parsePidsFromLsofOutput`), acknowledging the invariant
* "a cleanup step must never destroy its own caller." That invariant was
* applied only to the caller itself, not to its ancestors — which is how
* issue #68451 arises: a plugin sidecar calls the cleanup, `lsof` reports
* the parent gateway listening on 18789, the parent's PID passes the
* `pid !== process.pid` filter, it is SIGTERM'd, the sidecar is then reaped
* by the supervisor, the supervisor restarts the gateway, which re-spawns
* the sidecar, which runs the cleanup again — infinite restart loop.
*
* Completing the invariant here removes the loop at its source: killing any
* ancestor is exactly as fatal to the caller as killing itself, so ancestors
* must receive the same exclusion treatment. The check admits any positive
* ancestor PID (including 1), because inside a container — a first-class
* deployment target for this project — the gateway is frequently the
* entrypoint and therefore runs as PID 1 of its own namespace; excluding 1
* unconditionally would recreate the #68451 loop on every containerised
* install where the gateway spawns a direct-child sidecar.
*
* The walk is best-effort. `process.ppid` is provided by Node via a direct
* syscall and is always available; transitive ancestors are read on Linux via
* `/proc` and on macOS via `ps`. Windows stops at ppid.
*
* The function exposes no runtime hooks. Tests exercise the real walk by
* stubbing `process.ppid` (and, on Linux, by mocking `node:fs` to inject
* `/proc/<pid>/status` payloads) — there is no reachable override for
* runtime callers to mutate.
*/
function getSelfAndAncestorPidsSync(spawnTimeoutMs = SPAWN_TIMEOUT_MS) {
	const pids = new Set([process.pid]);
	const immediateParent = getParentPid();
	if (!Number.isFinite(immediateParent) || immediateParent <= 0) return pids;
	pids.add(immediateParent);
	const readTransitiveParent = process.platform === "linux" ? readParentPidFromProc : process.platform === "darwin" ? (pid) => readParentPidFromPs(pid, spawnTimeoutMs) : null;
	if (!readTransitiveParent) return pids;
	let current = immediateParent;
	for (let depth = 0; depth < MAX_ANCESTOR_WALK_DEPTH; depth++) {
		const parent = readTransitiveParent(current);
		if (parent == null || parent <= 0 || pids.has(parent)) break;
		pids.add(parent);
		current = parent;
	}
	return pids;
}
/**
* Parse raw PIDs from lsof -Fpc stdout, excluding the current
* process and its ancestors (see `getSelfAndAncestorPidsSync` for the full
* rationale). On Linux the ancestor lookup reads up to
* `MAX_ANCESTOR_WALK_DEPTH` entries from `/proc/<pid>/status`; each read is
* a virtual-filesystem access (no disk I/O, no external process), wrapped
* in try/catch and degrades silently. On macOS the lookup shells out to `ps`
* with the caller's spawn timeout. Windows only uses the in-memory direct
* parent from `process.ppid`.
*/
function parseLsofEntries(stdout) {
	const entries = [];
	let currentPid;
	let currentCmd;
	const flush = () => {
		if (currentPid != null) entries.push({
			pid: currentPid,
			...currentCmd ? { cmd: currentCmd } : {}
		});
	};
	for (const line of stdout.split(/\r?\n/).filter(Boolean)) if (line.startsWith("p")) {
		flush();
		const parsed = Number.parseInt(line.slice(1), 10);
		currentPid = Number.isFinite(parsed) && parsed > 0 ? parsed : void 0;
		currentCmd = void 0;
	} else if (line.startsWith("c")) currentCmd = line.slice(1);
	flush();
	return entries;
}
function parsePsCommandLine(raw) {
	const args = [];
	for (const match of raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
		const value = match[1] ?? match[2] ?? match[3];
		if (value) args.push(value);
	}
	return args;
}
function readUnixProcessArgsSync(pid, spawnTimeoutMs) {
	if (process.platform === "linux") try {
		const args = parseProcCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
		if (args.length > 0) return args;
	} catch {}
	const res = spawnSync("ps", [
		"-ww",
		"-p",
		String(pid),
		"-o",
		"command="
	], {
		encoding: "utf8",
		timeout: spawnTimeoutMs
	});
	if (res.error || res.status !== 0 || !res.stdout.trim()) return null;
	return parsePsCommandLine(res.stdout.trim());
}
function verifyGatewayPidByArgvSync(pid, spawnTimeoutMs) {
	const args = readUnixProcessArgsSync(pid, spawnTimeoutMs);
	return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
}
function parsePidsFromLsofOutput(stdout, spawnTimeoutMs) {
	const excluded = getSelfAndAncestorPidsSync(spawnTimeoutMs);
	const pids = [];
	for (const entry of parseLsofEntries(stdout)) {
		if (excluded.has(entry.pid)) continue;
		if (entry.cmd && normalizeLowercaseStringOrEmpty(entry.cmd).includes("openclaw")) {
			pids.push(entry.pid);
			continue;
		}
		if (verifyGatewayPidByArgvSync(entry.pid, spawnTimeoutMs)) pids.push(entry.pid);
	}
	return [...new Set(pids)];
}
/**
* Windows: find listening PIDs on the port, then verify each is an openclaw
* gateway process via command-line inspection. Excludes the current process
* and its ancestors (same invariant as the lsof path — see
* `getSelfAndAncestorPidsSync`).
*/
function filterVerifiedWindowsGatewayPids(rawPids) {
	const excluded = getSelfAndAncestorPidsSync();
	return Array.from(new Set(rawPids)).filter((pid) => Number.isFinite(pid) && pid > 0 && !excluded.has(pid)).filter((pid) => {
		const args = readWindowsProcessArgsSync(pid);
		return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
	});
}
function filterVerifiedWindowsGatewayPidsResult(rawPids, processArgsResult) {
	const excluded = getSelfAndAncestorPidsSync();
	const verified = [];
	for (const pid of Array.from(new Set(rawPids))) {
		if (!Number.isFinite(pid) || pid <= 0 || excluded.has(pid)) continue;
		const argsResult = processArgsResult(pid);
		if (!argsResult.ok) return {
			ok: false,
			permanent: argsResult.permanent
		};
		if (argsResult.args != null && isGatewayArgv(argsResult.args, { allowGatewayBinary: true })) verified.push(pid);
	}
	return {
		ok: true,
		pids: verified
	};
}
function findVerifiedWindowsGatewayPidsOnPortSync(port) {
	return filterVerifiedWindowsGatewayPids(readWindowsListeningPidsOnPortSync(port));
}
function findVerifiedWindowsGatewayPidsOnPortResultSync(port) {
	const result = readWindowsListeningPidsResultSync(port);
	if (!result.ok) return result;
	return filterVerifiedWindowsGatewayPidsResult(result.pids, (pid) => readWindowsProcessArgsResultSync(pid));
}
/**
* Find PIDs of gateway processes listening on the given port using synchronous lsof.
* Returns only PIDs that belong to openclaw gateway processes (not the current process).
*/
function findGatewayPidsOnPortSync(port, spawnTimeoutMs = SPAWN_TIMEOUT_MS) {
	if (process.platform === "win32") return findVerifiedWindowsGatewayPidsOnPortSync(port);
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
	if (res.status === 1) return [];
	if (res.status !== 0) {
		restartLog.warn(`lsof exited with status ${res.status} during initial stale-pid scan for port ${port}; skipping stale pid check`);
		return [];
	}
	return parsePidsFromLsofOutput(res.stdout, spawnTimeoutMs);
}
function pollPortOnce(port) {
	if (process.platform === "win32") return pollPortOnceWindows(port);
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
			if (res.stdout) return parsePidsFromLsofOutput(res.stdout, POLL_SPAWN_TIMEOUT_MS).length === 0 ? { free: true } : { free: false };
			return { free: true };
		}
		if (res.status !== 0) return {
			free: null,
			permanent: false
		};
		return parsePidsFromLsofOutput(res.stdout, POLL_SPAWN_TIMEOUT_MS).length === 0 ? { free: true } : { free: false };
	} catch {
		return {
			free: null,
			permanent: false
		};
	}
}
/**
* Windows-specific port poll.
* Uses a short timeout (POLL_SPAWN_TIMEOUT_MS) so a single slow PowerShell
* invocation cannot exceed the waitForPortFreeSync wall-clock budget.
* Only checks whether any process is listening — no gateway verification
* needed because we already killed the stale gateway in the prior step.
*/
function pollPortOnceWindows(port) {
	try {
		const result = readWindowsListeningPidsResultSync(port, POLL_SPAWN_TIMEOUT_MS);
		if (!result.ok) return {
			free: null,
			permanent: result.permanent
		};
		return result.pids.length === 0 ? { free: true } : { free: false };
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
*
* On Unix: sends SIGTERM, waits briefly, then SIGKILL for survivors.
* On Windows: uses taskkill (graceful first, then /F for force-kill).
*/
function terminateStaleProcessesSync(pids) {
	if (process.platform === "win32") return terminateStaleProcessesWindows(pids);
	const killed = [];
	for (const pid of pids) try {
		process.kill(pid, "SIGTERM");
		killed.push(pid);
	} catch {}
	if (killed.length === 0) return killed;
	sleepSync(STALE_SIGTERM_WAIT_MS);
	for (const pid of killed) try {
		process.kill(pid, 0);
		process.kill(pid, "SIGKILL");
	} catch {}
	sleepSync(STALE_SIGKILL_WAIT_MS);
	return killed;
}
/**
* Windows-specific process termination using taskkill.
* Sends a graceful taskkill first (/T for tree), waits, then escalates to /F.
*/
function terminateStaleProcessesWindows(pids) {
	const taskkillPath = path.win32.join(getWindowsInstallRoots().systemRoot, "System32", "taskkill.exe");
	const killed = [];
	for (const pid of pids) {
		const graceful = spawnSync(taskkillPath, [
			"/T",
			"/PID",
			String(pid)
		], {
			stdio: "ignore",
			timeout: 5e3,
			windowsHide: true
		});
		if (!(graceful.error != null || (graceful.status ?? 0) !== 0) && !isProcessAlive(pid)) {
			killed.push(pid);
			continue;
		}
		sleepSync(STALE_SIGTERM_WAIT_MS);
		if (!isProcessAlive(pid)) {
			killed.push(pid);
			continue;
		}
		const forced = spawnSync(taskkillPath, [
			"/F",
			"/T",
			"/PID",
			String(pid)
		], {
			stdio: "ignore",
			timeout: 5e3,
			windowsHide: true
		});
		if (forced.error != null || (forced.status ?? 0) !== 0) continue;
		sleepSync(STALE_SIGKILL_WAIT_MS);
		if (!isProcessAlive(pid)) killed.push(pid);
	}
	return killed;
}
function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
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
		if (result.free === true) return;
		if (result.free === null && result.permanent) return;
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
		const stalePids = process.platform === "win32" ? (() => {
			const result = findVerifiedWindowsGatewayPidsOnPortResultSync(port);
			if (result.ok) return result.pids;
			waitForPortFreeSync(port);
			return [];
		})() : findGatewayPidsOnPortSync(port);
		if (stalePids.length === 0) return [];
		restartLog.warn(`killing ${stalePids.length} stale gateway process(es) before restart: ${stalePids.join(", ")}`);
		const killed = terminateStaleProcessesSync(stalePids);
		waitForPortFreeSync(port);
		return killed;
	} catch {
		return [];
	}
}
//#endregion
export { readWindowsProcessArgsSync as a, readWindowsListeningPidsOnPortSync as i, findGatewayPidsOnPortSync as n, getSelfAndAncestorPidsSync as r, cleanStaleGatewayProcessesSync as t };
