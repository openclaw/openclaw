import { dt as sleep } from "./entry.js";
import { i as resolveLsofCommandSync, r as tryListenOnPort } from "./ports-B9YOEPbT.js";
import { execFileSync } from "node:child_process";

//#region src/cli/ports.ts
const FUSER_SIGNALS = {
	SIGTERM: "TERM",
	SIGKILL: "KILL"
};
function readExecOutput(value) {
	if (typeof value === "string") return value;
	if (value instanceof Buffer) return value.toString("utf8");
	return "";
}
function withErrnoCode(message, code, cause) {
	const out = new Error(message, { cause: cause instanceof Error ? cause : void 0 });
	out.code = code;
	return out;
}
function getErrnoCode(err) {
	if (!err || typeof err !== "object") return;
	const direct = err.code;
	if (typeof direct === "string" && direct.length > 0) return direct;
	const cause = err.cause;
	if (cause && typeof cause === "object") {
		const nested = cause.code;
		if (typeof nested === "string" && nested.length > 0) return nested;
	}
}
function isRecoverableLsofError(err) {
	const code = getErrnoCode(err);
	if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return true;
	const message = err instanceof Error ? err.message : String(err);
	return /lsof.*(permission denied|not permitted|operation not permitted|eacces|eperm)/i.test(message);
}
function parseFuserPidList(output) {
	if (!output) return [];
	const values = /* @__PURE__ */ new Set();
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const pidMatches = (line.includes(":") ? line.slice(line.indexOf(":") + 1) : line).match(/\d+/g) ?? [];
		for (const match of pidMatches) {
			const pid = Number.parseInt(match, 10);
			if (Number.isFinite(pid) && pid > 0) values.add(pid);
		}
	}
	return [...values];
}
function killPortWithFuser(port, signal) {
	const args = [
		"-k",
		`-${FUSER_SIGNALS[signal]}`,
		`${port}/tcp`
	];
	try {
		return parseFuserPidList(execFileSync("fuser", args, {
			encoding: "utf-8",
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		})).map((pid) => ({ pid }));
	} catch (err) {
		const execErr = err;
		const code = execErr.code;
		const status = execErr.status;
		const parsed = parseFuserPidList([readExecOutput(execErr.stdout), readExecOutput(execErr.stderr)].filter(Boolean).join("\n"));
		if (status === 1) return parsed.map((pid) => ({ pid }));
		if (code === "ENOENT") throw withErrnoCode("fuser not found; required for --force when lsof is unavailable", "ENOENT", err);
		if (code === "EACCES" || code === "EPERM") throw withErrnoCode("fuser permission denied while forcing gateway port", code, err);
		throw err instanceof Error ? err : new Error(String(err));
	}
}
async function isPortBusy(port) {
	try {
		await tryListenOnPort({
			port,
			exclusive: true
		});
		return false;
	} catch (err) {
		if (err.code === "EADDRINUSE") return true;
		throw err instanceof Error ? err : new Error(String(err));
	}
}
function parseLsofOutput(output) {
	const lines = output.split(/\r?\n/).filter(Boolean);
	const results = [];
	let current = {};
	for (const line of lines) if (line.startsWith("p")) {
		if (current.pid) results.push(current);
		current = { pid: Number.parseInt(line.slice(1), 10) };
	} else if (line.startsWith("c")) current.command = line.slice(1);
	if (current.pid) results.push(current);
	return results;
}
function listPortListeners(port) {
	try {
		return parseLsofOutput(execFileSync(resolveLsofCommandSync(), [
			"-nP",
			`-iTCP:${port}`,
			"-sTCP:LISTEN",
			"-FpFc"
		], { encoding: "utf-8" }));
	} catch (err) {
		const execErr = err;
		const status = execErr.status ?? void 0;
		const code = execErr.code;
		if (code === "ENOENT") throw withErrnoCode("lsof not found; required for --force", "ENOENT", err);
		if (code === "EACCES" || code === "EPERM") throw withErrnoCode("lsof permission denied while inspecting gateway port", code, err);
		if (status === 1) {
			const stderr = readExecOutput(execErr.stderr).trim();
			if (stderr && /permission denied|not permitted|operation not permitted|can't stat/i.test(stderr)) throw withErrnoCode(`lsof permission denied while inspecting gateway port: ${stderr}`, "EACCES", err);
			return [];
		}
		throw err instanceof Error ? err : new Error(String(err));
	}
}
function forceFreePort(port) {
	const listeners = listPortListeners(port);
	for (const proc of listeners) try {
		process.kill(proc.pid, "SIGTERM");
	} catch (err) {
		throw new Error(`failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`, { cause: err });
	}
	return listeners;
}
function killPids(listeners, signal) {
	for (const proc of listeners) try {
		process.kill(proc.pid, signal);
	} catch (err) {
		throw new Error(`failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`, { cause: err });
	}
}
async function forceFreePortAndWait(port, opts = {}) {
	const timeoutMs = Math.max(opts.timeoutMs ?? 1500, 0);
	const intervalMs = Math.max(opts.intervalMs ?? 100, 1);
	const sigtermTimeoutMs = Math.min(Math.max(opts.sigtermTimeoutMs ?? 600, 0), timeoutMs);
	let killed = [];
	let useFuserFallback = false;
	try {
		killed = forceFreePort(port);
	} catch (err) {
		if (!isRecoverableLsofError(err)) throw err;
		useFuserFallback = true;
		killed = killPortWithFuser(port, "SIGTERM");
	}
	const checkBusy = async () => useFuserFallback ? isPortBusy(port) : listPortListeners(port).length > 0;
	if (!await checkBusy()) return {
		killed,
		waitedMs: 0,
		escalatedToSigkill: false
	};
	let waitedMs = 0;
	const triesSigterm = intervalMs > 0 ? Math.ceil(sigtermTimeoutMs / intervalMs) : 0;
	for (let i = 0; i < triesSigterm; i++) {
		if (!await checkBusy()) return {
			killed,
			waitedMs,
			escalatedToSigkill: false
		};
		await sleep(intervalMs);
		waitedMs += intervalMs;
	}
	if (!await checkBusy()) return {
		killed,
		waitedMs,
		escalatedToSigkill: false
	};
	if (useFuserFallback) killPortWithFuser(port, "SIGKILL");
	else killPids(listPortListeners(port), "SIGKILL");
	const remainingBudget = Math.max(timeoutMs - waitedMs, 0);
	const triesSigkill = intervalMs > 0 ? Math.ceil(remainingBudget / intervalMs) : 0;
	for (let i = 0; i < triesSigkill; i++) {
		if (!await checkBusy()) return {
			killed,
			waitedMs,
			escalatedToSigkill: true
		};
		await sleep(intervalMs);
		waitedMs += intervalMs;
	}
	if (!await checkBusy()) return {
		killed,
		waitedMs,
		escalatedToSigkill: true
	};
	if (useFuserFallback) throw new Error(`port ${port} still has listeners after --force (fuser fallback)`);
	const still = listPortListeners(port);
	throw new Error(`port ${port} still has listeners after --force: ${still.map((p) => p.pid).join(", ")}`);
}

//#endregion
export { forceFreePortAndWait as n, forceFreePort as t };