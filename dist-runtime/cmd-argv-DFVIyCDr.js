import { t as splitArgsPreservingQuotes } from "./arg-split-Ce7k_3HT.js";
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
*/
function killProcessTree(pid, opts) {
	if (!Number.isFinite(pid) || pid <= 0) {return;}
	const graceMs = normalizeGraceMs(opts?.graceMs);
	if (process.platform === "win32") {
		killProcessTreeWindows(pid, graceMs);
		return;
	}
	killProcessTreeUnix(pid, graceMs);
}
function normalizeGraceMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) {return DEFAULT_GRACE_MS;}
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
function killProcessTreeUnix(pid, graceMs) {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return;
		}
	}
	setTimeout(() => {
		if (isProcessAlive(-pid)) {try {
			process.kill(-pid, "SIGKILL");
			return;
		} catch {}}
		if (!isProcessAlive(pid)) {return;}
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
		if (!isProcessAlive(pid)) {return;}
		runTaskkill([
			"/F",
			"/T",
			"/PID",
			String(pid)
		]);
	}, graceMs).unref();
}
//#endregion
//#region src/daemon/cmd-set.ts
function assertNoCmdLineBreak(value, field) {
	if (/[\r\n]/.test(value)) {throw new Error(`${field} cannot contain CR or LF in Windows task scripts.`);}
}
function escapeCmdSetAssignmentComponent(value) {
	return value.replace(/\^/g, "^^").replace(/%/g, "%%").replace(/!/g, "^!").replace(/"/g, "^\"");
}
function unescapeCmdSetAssignmentComponent(value) {
	let out = "";
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		const next = value[i + 1];
		if (ch === "^" && (next === "^" || next === "\"" || next === "!")) {
			out += next;
			i += 1;
			continue;
		}
		if (ch === "%" && next === "%") {
			out += "%";
			i += 1;
			continue;
		}
		out += ch;
	}
	return out;
}
function parseCmdSetAssignment(line) {
	const raw = line.trim();
	if (!raw) {return null;}
	const quoted = raw.startsWith("\"") && raw.endsWith("\"") && raw.length >= 2;
	const assignment = quoted ? raw.slice(1, -1) : raw;
	const index = assignment.indexOf("=");
	if (index <= 0) {return null;}
	const key = assignment.slice(0, index).trim();
	const value = assignment.slice(index + 1).trim();
	if (!key) {return null;}
	if (!quoted) {return {
		key,
		value
	};}
	return {
		key: unescapeCmdSetAssignmentComponent(key),
		value: unescapeCmdSetAssignmentComponent(value)
	};
}
function renderCmdSetAssignment(key, value) {
	assertNoCmdLineBreak(key, "Environment variable name");
	assertNoCmdLineBreak(value, "Environment variable value");
	return `set "${escapeCmdSetAssignmentComponent(key)}=${escapeCmdSetAssignmentComponent(value)}"`;
}
//#endregion
//#region src/daemon/cmd-argv.ts
function quoteCmdScriptArg(value) {
	assertNoCmdLineBreak(value, "Command argument");
	if (!value) {return "\"\"";}
	const escaped = value.replace(/"/g, "\\\"").replace(/%/g, "%%").replace(/!/g, "^!");
	if (!/[ \t"&|<>^()%!]/g.test(value)) {return escaped;}
	return `"${escaped}"`;
}
function unescapeCmdScriptArg(value) {
	return value.replace(/\^!/g, "!").replace(/%%/g, "%");
}
function parseCmdScriptCommandLine(value) {
	return splitArgsPreservingQuotes(value, { escapeMode: "backslash-quote-only" }).map(unescapeCmdScriptArg);
}
//#endregion
export { renderCmdSetAssignment as a, parseCmdSetAssignment as i, quoteCmdScriptArg as n, killProcessTree as o, assertNoCmdLineBreak as r, parseCmdScriptCommandLine as t };
