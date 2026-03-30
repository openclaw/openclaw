import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { t as runCommandWithTimeout } from "./exec-BhaMholX.js";
import { a as isErrno } from "./errors-Cu3BYw29.js";
import fs from "node:fs";
import fs$1 from "node:fs/promises";
import net from "node:net";

//#region src/infra/ports-format.ts
function classifyPortListener(listener, port) {
	const raw = `${listener.commandLine ?? ""} ${listener.command ?? ""}`.trim().toLowerCase();
	if (raw.includes("openclaw")) return "gateway";
	if (raw.includes("ssh")) {
		const portToken = String(port);
		const tunnelPattern = new RegExp(`-(l|r)\\s*${portToken}\\b|-(l|r)${portToken}\\b|:${portToken}\\b`);
		if (!raw || tunnelPattern.test(raw)) return "ssh";
		return "ssh";
	}
	return "unknown";
}
function buildPortHints(listeners, port) {
	if (listeners.length === 0) return [];
	const kinds = new Set(listeners.map((listener) => classifyPortListener(listener, port)));
	const hints = [];
	if (kinds.has("gateway")) hints.push(`Gateway already running locally. Stop it (${formatCliCommand("openclaw gateway stop")}) or use a different port.`);
	if (kinds.has("ssh")) hints.push("SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.");
	if (kinds.has("unknown")) hints.push("Another process is listening on this port.");
	if (listeners.length > 1) hints.push("Multiple listeners detected; ensure only one gateway/tunnel per port unless intentionally running isolated profiles.");
	return hints;
}
function formatPortListener(listener) {
	return `${listener.pid ? `pid ${listener.pid}` : "pid ?"}${listener.user ? ` ${listener.user}` : ""}: ${listener.commandLine || listener.command || "unknown"}${listener.address ? ` (${listener.address})` : ""}`;
}
function formatPortDiagnostics(diagnostics) {
	if (diagnostics.status !== "busy") return [`Port ${diagnostics.port} is free.`];
	const lines = [`Port ${diagnostics.port} is already in use.`];
	for (const listener of diagnostics.listeners) lines.push(`- ${formatPortListener(listener)}`);
	for (const hint of diagnostics.hints) lines.push(`- ${hint}`);
	return lines;
}

//#endregion
//#region src/infra/ports-lsof.ts
const LSOF_CANDIDATES = process.platform === "darwin" ? ["/usr/sbin/lsof", "/usr/bin/lsof"] : ["/usr/bin/lsof", "/usr/sbin/lsof"];
async function canExecute(path) {
	try {
		await fs$1.access(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
async function resolveLsofCommand() {
	for (const candidate of LSOF_CANDIDATES) if (await canExecute(candidate)) return candidate;
	return "lsof";
}
function resolveLsofCommandSync() {
	for (const candidate of LSOF_CANDIDATES) try {
		fs.accessSync(candidate, fs.constants.X_OK);
		return candidate;
	} catch {}
	return "lsof";
}

//#endregion
//#region src/infra/ports-probe.ts
async function tryListenOnPort(params) {
	const listenOptions = { port: params.port };
	if (params.host) listenOptions.host = params.host;
	if (typeof params.exclusive === "boolean") listenOptions.exclusive = params.exclusive;
	await new Promise((resolve, reject) => {
		const tester = net.createServer().once("error", (err) => reject(err)).once("listening", () => {
			tester.close(() => resolve());
		}).listen(listenOptions);
	});
}

//#endregion
//#region src/infra/ports-inspect.ts
async function runCommandSafe(argv, timeoutMs = 5e3) {
	try {
		const res = await runCommandWithTimeout(argv, { timeoutMs });
		return {
			stdout: res.stdout,
			stderr: res.stderr,
			code: res.code ?? 1
		};
	} catch (err) {
		return {
			stdout: "",
			stderr: "",
			code: 1,
			error: String(err)
		};
	}
}
function parseLsofFieldOutput(output) {
	const lines = output.split(/\r?\n/).filter(Boolean);
	const listeners = [];
	let current = {};
	for (const line of lines) if (line.startsWith("p")) {
		if (current.pid || current.command) listeners.push(current);
		const pid = Number.parseInt(line.slice(1), 10);
		current = Number.isFinite(pid) ? { pid } : {};
	} else if (line.startsWith("c")) current.command = line.slice(1);
	else if (line.startsWith("n")) {
		if (!current.address) current.address = line.slice(1);
	}
	if (current.pid || current.command) listeners.push(current);
	return listeners;
}
async function resolveUnixCommandLine(pid) {
	const res = await runCommandSafe([
		"ps",
		"-p",
		String(pid),
		"-o",
		"command="
	]);
	if (res.code !== 0) return;
	return res.stdout.trim() || void 0;
}
async function resolveUnixUser(pid) {
	const res = await runCommandSafe([
		"ps",
		"-p",
		String(pid),
		"-o",
		"user="
	]);
	if (res.code !== 0) return;
	return res.stdout.trim() || void 0;
}
async function resolveUnixParentPid(pid) {
	const res = await runCommandSafe([
		"ps",
		"-p",
		String(pid),
		"-o",
		"ppid="
	]);
	if (res.code !== 0) return;
	const line = res.stdout.trim();
	const parentPid = Number.parseInt(line, 10);
	return Number.isFinite(parentPid) && parentPid > 0 ? parentPid : void 0;
}
async function readUnixListeners(port) {
	const errors = [];
	const res = await runCommandSafe([
		await resolveLsofCommand(),
		"-nP",
		`-iTCP:${port}`,
		"-sTCP:LISTEN",
		"-FpFcn"
	]);
	if (res.code === 0) {
		const listeners = parseLsofFieldOutput(res.stdout);
		await Promise.all(listeners.map(async (listener) => {
			if (!listener.pid) return;
			const [commandLine, user, parentPid] = await Promise.all([
				resolveUnixCommandLine(listener.pid),
				resolveUnixUser(listener.pid),
				resolveUnixParentPid(listener.pid)
			]);
			if (commandLine) listener.commandLine = commandLine;
			if (user) listener.user = user;
			if (parentPid !== void 0) listener.ppid = parentPid;
		}));
		return {
			listeners,
			detail: res.stdout.trim() || void 0,
			errors
		};
	}
	const stderr = res.stderr.trim();
	if (res.code === 1 && !res.error && !stderr) return {
		listeners: [],
		detail: void 0,
		errors
	};
	if (res.error) errors.push(res.error);
	const detail = [stderr, res.stdout.trim()].filter(Boolean).join("\n");
	if (detail) errors.push(detail);
	return {
		listeners: [],
		detail: void 0,
		errors
	};
}
function parseNetstatListeners(output, port) {
	const listeners = [];
	const portToken = `:${port}`;
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (!line.toLowerCase().includes("listen")) continue;
		if (!line.includes(portToken)) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 4) continue;
		const pidRaw = parts.at(-1);
		const pid = pidRaw ? Number.parseInt(pidRaw, 10) : NaN;
		const localAddr = parts[1];
		const listener = {};
		if (Number.isFinite(pid)) listener.pid = pid;
		if (localAddr?.includes(portToken)) listener.address = localAddr;
		listeners.push(listener);
	}
	return listeners;
}
async function resolveWindowsImageName(pid) {
	const res = await runCommandSafe([
		"tasklist",
		"/FI",
		`PID eq ${pid}`,
		"/FO",
		"LIST"
	]);
	if (res.code !== 0) return;
	for (const rawLine of res.stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.toLowerCase().startsWith("image name:")) continue;
		return line.slice(11).trim() || void 0;
	}
}
async function resolveWindowsCommandLine(pid) {
	const res = await runCommandSafe([
		"wmic",
		"process",
		"where",
		`ProcessId=${pid}`,
		"get",
		"CommandLine",
		"/value"
	]);
	if (res.code !== 0) return;
	for (const rawLine of res.stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.toLowerCase().startsWith("commandline=")) continue;
		return line.slice(12).trim() || void 0;
	}
}
async function readWindowsListeners(port) {
	const errors = [];
	const res = await runCommandSafe([
		"netstat",
		"-ano",
		"-p",
		"tcp"
	]);
	if (res.code !== 0) {
		if (res.error) errors.push(res.error);
		const detail = [res.stderr.trim(), res.stdout.trim()].filter(Boolean).join("\n");
		if (detail) errors.push(detail);
		return {
			listeners: [],
			errors
		};
	}
	const listeners = parseNetstatListeners(res.stdout, port);
	await Promise.all(listeners.map(async (listener) => {
		if (!listener.pid) return;
		const [imageName, commandLine] = await Promise.all([resolveWindowsImageName(listener.pid), resolveWindowsCommandLine(listener.pid)]);
		if (imageName) listener.command = imageName;
		if (commandLine) listener.commandLine = commandLine;
	}));
	return {
		listeners,
		detail: res.stdout.trim() || void 0,
		errors
	};
}
async function tryListenOnHost(port, host) {
	try {
		await tryListenOnPort({
			port,
			host,
			exclusive: true
		});
		return "free";
	} catch (err) {
		if (isErrno(err) && err.code === "EADDRINUSE") return "busy";
		if (isErrno(err) && (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")) return "skip";
		return "unknown";
	}
}
async function checkPortInUse(port) {
	const hosts = [
		"127.0.0.1",
		"0.0.0.0",
		"::1",
		"::"
	];
	let sawUnknown = false;
	for (const host of hosts) {
		const result = await tryListenOnHost(port, host);
		if (result === "busy") return "busy";
		if (result === "unknown") sawUnknown = true;
	}
	return sawUnknown ? "unknown" : "free";
}
async function inspectPortUsage(port) {
	const errors = [];
	const result = process.platform === "win32" ? await readWindowsListeners(port) : await readUnixListeners(port);
	errors.push(...result.errors);
	let listeners = result.listeners;
	let status = listeners.length > 0 ? "busy" : "unknown";
	if (listeners.length === 0) status = await checkPortInUse(port);
	if (status !== "busy") listeners = [];
	const hints = buildPortHints(listeners, port);
	if (status === "busy" && listeners.length === 0) hints.push("Port is in use but process details are unavailable (install lsof or run as an admin user).");
	return {
		port,
		status,
		listeners,
		hints,
		detail: result.detail,
		errors: errors.length > 0 ? errors : void 0
	};
}

//#endregion
//#region src/infra/ports.ts
var PortInUseError = class extends Error {
	constructor(port, details) {
		super(`Port ${port} is already in use.`);
		this.name = "PortInUseError";
		this.port = port;
		this.details = details;
	}
};
async function ensurePortAvailable(port) {
	try {
		await tryListenOnPort({ port });
	} catch (err) {
		if (isErrno(err) && err.code === "EADDRINUSE") throw new PortInUseError(port);
		throw err;
	}
}

//#endregion
export { classifyPortListener as a, resolveLsofCommandSync as i, inspectPortUsage as n, formatPortDiagnostics as o, tryListenOnPort as r, ensurePortAvailable as t };