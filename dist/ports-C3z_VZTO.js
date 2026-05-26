import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { s as isErrno } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { a as shouldLogVerbose, n as info, s as warn, t as danger } from "./globals-YU5FjfZK.js";
import { t as logDebug } from "./logger-0o2znY2U.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { t as resolveLsofCommand } from "./ports-lsof-BmdLddJi.js";
import { t as tryListenOnPort } from "./ports-probe-Dd2mseNP.js";
import os from "node:os";
//#region src/infra/ports-format.ts
function classifyPortListener(listener, port) {
	const raw = normalizeLowercaseStringOrEmpty(`${listener.commandLine ?? ""} ${listener.command ?? ""}`);
	if (raw.includes("openclaw")) return "gateway";
	if (raw.includes("ssh")) {
		const portToken = String(port);
		const tunnelPattern = new RegExp(`-(l|r)\\s*${portToken}\\b|-(l|r)${portToken}\\b|:${portToken}\\b`);
		if (!raw || tunnelPattern.test(raw)) return "ssh";
		return "ssh";
	}
	return "unknown";
}
function parseListenerAddress(address) {
	const trimmed = address.trim();
	if (!trimmed) return null;
	const normalized = trimmed.replace(/^tcp6?\s+/i, "").replace(/\s*\(listen\)\s*$/i, "");
	const bracketMatch = normalized.match(/^\[([^\]]+)\]:(\d+)$/);
	if (bracketMatch) {
		const port = Number.parseInt(bracketMatch[2], 10);
		return Number.isFinite(port) ? {
			host: normalizeLowercaseStringOrEmpty(bracketMatch[1]),
			port
		} : null;
	}
	const lastColon = normalized.lastIndexOf(":");
	if (lastColon <= 0 || lastColon >= normalized.length - 1) return null;
	const host = normalizeLowercaseStringOrEmpty(normalized.slice(0, lastColon));
	const portToken = normalized.slice(lastColon + 1).trim();
	if (!/^\d+$/.test(portToken)) return null;
	const port = Number.parseInt(portToken, 10);
	return Number.isFinite(port) ? {
		host,
		port
	} : null;
}
function classifyLoopbackAddressFamily(host) {
	if (host === "127.0.0.1" || host === "localhost") return "ipv4";
	if (host === "::1") return "ipv6";
	if (host.startsWith("::ffff:")) return host.slice(7) === "127.0.0.1" ? "ipv6" : null;
	return null;
}
function isWildcardAddress(host) {
	return host === "0.0.0.0" || host === "::" || host === "*";
}
function isExpectedGatewayBindAddress(host) {
	return classifyLoopbackAddressFamily(host) !== null || isWildcardAddress(host);
}
function isSingleExpectedGatewayListener(listeners, port) {
	if (listeners.length !== 1) return false;
	const [listener] = listeners;
	if (!listener || classifyPortListener(listener, port) !== "gateway") return false;
	const pid = listener.pid;
	if (typeof pid !== "number" || !Number.isFinite(pid)) return false;
	if (typeof listener.address !== "string") return false;
	const parsedAddress = parseListenerAddress(listener.address);
	return Boolean(parsedAddress && parsedAddress.port === port && isExpectedGatewayBindAddress(parsedAddress.host));
}
function isDualStackLoopbackGatewayListeners(listeners, port) {
	if (listeners.length < 2) return false;
	const pids = /* @__PURE__ */ new Set();
	const families = /* @__PURE__ */ new Set();
	for (const listener of listeners) {
		if (classifyPortListener(listener, port) !== "gateway") return false;
		const pid = listener.pid;
		if (typeof pid !== "number" || !Number.isFinite(pid)) return false;
		pids.add(pid);
		if (typeof listener.address !== "string") return false;
		const parsedAddress = parseListenerAddress(listener.address);
		if (!parsedAddress || parsedAddress.port !== port) return false;
		const family = classifyLoopbackAddressFamily(parsedAddress.host);
		if (!family) return false;
		families.add(family);
	}
	return pids.size === 1 && families.has("ipv4") && families.has("ipv6");
}
function isExpectedGatewayListeners(listeners, port) {
	return isSingleExpectedGatewayListener(listeners, port) || isDualStackLoopbackGatewayListeners(listeners, port);
}
function buildPortHints(listeners, port) {
	if (listeners.length === 0) return [];
	const kinds = new Set(listeners.map((listener) => classifyPortListener(listener, port)));
	const hints = [];
	const expectedGatewayListeners = isExpectedGatewayListeners(listeners, port);
	if (kinds.has("gateway") && !expectedGatewayListeners) hints.push(`Gateway already running locally. Stop it (${formatCliCommand("openclaw gateway stop")}) or use a different port.`);
	if (kinds.has("ssh")) hints.push("SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.");
	if (kinds.has("unknown")) hints.push("Another process is listening on this port.");
	if (listeners.length > 1 && !expectedGatewayListeners) hints.push("Multiple listeners detected; ensure only one gateway/tunnel per port unless intentionally running isolated profiles.");
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
function normalizeTcpHost(host) {
	const normalized = host.toLowerCase();
	return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}
function parseTcpEndpoint(raw) {
	const endpoint = raw.trim();
	const bracketMatch = endpoint.match(/^\[([^\]]+)\]:(\d+)$/);
	if (bracketMatch) {
		const port = Number.parseInt(bracketMatch[2], 10);
		return Number.isFinite(port) ? {
			host: normalizeTcpHost(bracketMatch[1]),
			port
		} : null;
	}
	const lastColon = endpoint.lastIndexOf(":");
	if (lastColon <= 0 || lastColon >= endpoint.length - 1) return null;
	const port = Number.parseInt(endpoint.slice(lastColon + 1), 10);
	if (!Number.isFinite(port)) return null;
	return {
		host: normalizeTcpHost(endpoint.slice(0, lastColon)),
		port
	};
}
function parseLsofTcpConnectionAddress(address) {
	const normalized = address?.replace(/^tcp\s+/i, "").replace(/\s*\([^)]*\)\s*$/i, "").trim();
	if (!normalized?.includes("->")) return null;
	const [localRaw, remoteRaw] = normalized.split("->", 2);
	const local = parseTcpEndpoint(localRaw ?? "");
	const remote = parseTcpEndpoint(remoteRaw ?? "");
	return local && remote ? {
		local,
		remote
	} : null;
}
function resolveLocalNetworkAddresses() {
	const addresses = new Set([
		"127.0.0.1",
		"::1",
		"localhost",
		"0.0.0.0",
		"::"
	]);
	for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries ?? []) addresses.add(entry.address.toLowerCase());
	return addresses;
}
function isGatewayConnectionAddress(address, port, localAddresses) {
	const parsed = parseLsofTcpConnectionAddress(address);
	if (!parsed) return false;
	if (parsed.local.port === port) return true;
	return parsed.remote.port === port && localAddresses.has(parsed.remote.host);
}
function resolveLsofTcpDirection(address, port) {
	const parsed = parseLsofTcpConnectionAddress(address);
	if (!parsed) return "unknown";
	if (parsed.local.port === port) return "server";
	return parsed.remote.port === port ? "client" : "unknown";
}
function parseLsofConnectionFieldOutput(output, port) {
	const connections = [];
	const localAddresses = resolveLocalNetworkAddresses();
	for (const entry of parseLsofFieldOutput(output)) {
		if (!isGatewayConnectionAddress(entry.address, port, localAddresses)) continue;
		const connection = entry;
		connection.direction = resolveLsofTcpDirection(entry.address, port);
		connections.push(connection);
	}
	return connections;
}
function parseSsConnectionEndpoint(raw) {
	if (raw.startsWith("users:")) return null;
	if (raw.includes(":")) return raw;
	return null;
}
function parseSsConnections(output, port) {
	const connections = [];
	const localAddresses = resolveLocalNetworkAddresses();
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const endpoints = line.split(/\s+/).map(parseSsConnectionEndpoint).filter((endpoint) => Boolean(endpoint));
		if (endpoints.length < 2) continue;
		const [local, remote] = endpoints.slice(-2);
		const address = `TCP ${local}->${remote} (ESTABLISHED)`;
		if (!isGatewayConnectionAddress(address, port, localAddresses)) continue;
		const connection = {
			address,
			direction: resolveLsofTcpDirection(address, port)
		};
		const pidMatch = line.match(/pid=(\d+)/);
		if (pidMatch) {
			const pid = Number.parseInt(pidMatch[1], 10);
			if (Number.isFinite(pid)) connection.pid = pid;
		}
		const commandMatch = line.match(/users:\(\("([^"]+)"/);
		if (commandMatch?.[1]) connection.command = commandMatch[1];
		connections.push(connection);
	}
	return connections;
}
async function enrichUnixListenerProcessInfo(listeners) {
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
}
async function readUnixEstablishedConnectionsFromSs(port) {
	const errors = [];
	const res = await runCommandSafe([
		"ss",
		"-H",
		"-tnp",
		"state",
		"established",
		`( sport = :${port} or dport = :${port} )`
	]);
	if (res.code === 0) {
		const connections = parseSsConnections(res.stdout, port);
		await enrichUnixListenerProcessInfo(connections);
		return {
			connections,
			detail: res.stdout.trim() || void 0,
			errors
		};
	}
	const stderr = res.stderr.trim();
	if (res.code === 1 && !res.error && !stderr) return {
		connections: [],
		detail: void 0,
		errors
	};
	if (res.error) errors.push(res.error);
	const detail = [stderr, res.stdout.trim()].filter(Boolean).join("\n");
	if (detail) errors.push(detail);
	return {
		connections: [],
		detail: void 0,
		errors
	};
}
async function readUnixEstablishedConnections(port) {
	const res = await runCommandSafe([
		await resolveLsofCommand(),
		"-nP",
		`-iTCP:${port}`,
		"-sTCP:ESTABLISHED",
		"-FpFcn"
	]);
	if (res.code === 0) {
		const connections = parseLsofConnectionFieldOutput(res.stdout, port);
		await enrichUnixListenerProcessInfo(connections);
		return {
			connections,
			detail: res.stdout.trim() || void 0,
			errors: []
		};
	}
	const stderr = res.stderr.trim();
	if (res.code === 1 && !res.error && !stderr) return {
		connections: [],
		detail: void 0,
		errors: []
	};
	const errors = [];
	if (res.error) errors.push(res.error);
	const detail = [stderr, res.stdout.trim()].filter(Boolean).join("\n");
	if (detail) errors.push(detail);
	const ssFallback = await readUnixEstablishedConnectionsFromSs(port);
	if (ssFallback.connections.length > 0) return ssFallback;
	return {
		connections: [],
		detail: void 0,
		errors: [...errors, ...ssFallback.errors]
	};
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
function parseSsListeners(output, port) {
	const lines = output.split(/\r?\n/).map((line) => line.trim());
	const listeners = [];
	for (const line of lines) {
		if (!line || !line.includes("LISTEN")) continue;
		const localAddress = line.split(/\s+/).find((part) => part.includes(`:${port}`));
		if (!localAddress) continue;
		const listener = { address: localAddress };
		const pidMatch = line.match(/pid=(\d+)/);
		if (pidMatch) {
			const pid = Number.parseInt(pidMatch[1], 10);
			if (Number.isFinite(pid)) listener.pid = pid;
		}
		const commandMatch = line.match(/users:\(\("([^"]+)"/);
		if (commandMatch?.[1]) listener.command = commandMatch[1];
		listeners.push(listener);
	}
	return listeners;
}
async function readUnixListenersFromSs(port) {
	const errors = [];
	const res = await runCommandSafe([
		"ss",
		"-H",
		"-ltnp",
		`sport = :${port}`
	]);
	if (res.code === 0) {
		const listeners = parseSsListeners(res.stdout, port);
		await enrichUnixListenerProcessInfo(listeners);
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
async function readUnixListeners(port) {
	const res = await runCommandSafe([
		await resolveLsofCommand(),
		"-nP",
		`-iTCP:${port}`,
		"-sTCP:LISTEN",
		"-FpFcn"
	]);
	if (res.code === 0) {
		const listeners = parseLsofFieldOutput(res.stdout);
		await enrichUnixListenerProcessInfo(listeners);
		return {
			listeners,
			detail: res.stdout.trim() || void 0,
			errors: []
		};
	}
	const lsofErrors = [];
	const stderr = res.stderr.trim();
	if (res.code === 1 && !res.error && !stderr) return {
		listeners: [],
		detail: void 0,
		errors: []
	};
	if (res.error) lsofErrors.push(res.error);
	const detail = [stderr, res.stdout.trim()].filter(Boolean).join("\n");
	if (detail) lsofErrors.push(detail);
	const ssFallback = await readUnixListenersFromSs(port);
	if (ssFallback.listeners.length > 0) return ssFallback;
	return {
		listeners: [],
		detail: void 0,
		errors: [...lsofErrors, ...ssFallback.errors]
	};
}
function parseNetstatListeners(output, port) {
	const listeners = [];
	const portToken = `:${port}`;
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (!normalizeLowercaseStringOrEmpty(line).includes("listen")) continue;
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
function parseNetstatConnections(output, port) {
	const connections = [];
	const localAddresses = resolveLocalNetworkAddresses();
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || !normalizeLowercaseStringOrEmpty(line).includes("established")) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 5) continue;
		const local = parts[1];
		const remote = parts[2];
		const pidRaw = parts.at(-1);
		if (!local || !remote || !pidRaw) continue;
		const address = `TCP ${local}->${remote} (ESTABLISHED)`;
		if (!isGatewayConnectionAddress(address, port, localAddresses)) continue;
		const connection = {
			address,
			direction: resolveLsofTcpDirection(address, port)
		};
		const pid = Number.parseInt(pidRaw, 10);
		if (Number.isFinite(pid)) connection.pid = pid;
		connections.push(connection);
	}
	return connections;
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
		if (!normalizeLowercaseStringOrEmpty(line).startsWith("image name:")) continue;
		return line.slice(11).trim() || void 0;
	}
}
async function resolveWindowsCommandLine(pid) {
	const powershell = await runCommandSafe([
		"powershell",
		"-NoProfile",
		"-Command",
		`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`
	]);
	if (powershell.code === 0) {
		const value = powershell.stdout.trim();
		if (value) return value;
	}
	const wmic = await runCommandSafe([
		"wmic",
		"process",
		"where",
		`ProcessId=${pid}`,
		"get",
		"CommandLine",
		"/value"
	]);
	if (wmic.code !== 0) return;
	for (const rawLine of wmic.stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!normalizeLowercaseStringOrEmpty(line).startsWith("commandline=")) continue;
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
async function readWindowsEstablishedConnections(port) {
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
			connections: [],
			errors
		};
	}
	const connections = parseNetstatConnections(res.stdout, port);
	await Promise.all(connections.map(async (connection) => {
		if (!connection.pid) return;
		const [imageName, commandLine] = await Promise.all([resolveWindowsImageName(connection.pid), resolveWindowsCommandLine(connection.pid)]);
		if (imageName) connection.command = imageName;
		if (commandLine) connection.commandLine = commandLine;
	}));
	return {
		connections,
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
async function inspectPortConnections(port) {
	const result = process.platform === "win32" ? await readWindowsEstablishedConnections(port) : await readUnixEstablishedConnections(port);
	return {
		port,
		connections: result.connections,
		detail: result.detail,
		errors: result.errors.length > 0 ? result.errors : void 0
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
async function describePortOwner(port) {
	const diagnostics = await inspectPortUsage(port);
	if (diagnostics.listeners.length === 0) return;
	return formatPortDiagnostics(diagnostics).join("\n");
}
async function ensurePortAvailable(port) {
	try {
		await tryListenOnPort({ port });
	} catch (err) {
		if (isErrno(err) && err.code === "EADDRINUSE") throw new PortInUseError(port);
		throw err;
	}
}
async function handlePortError(err, port, context, runtime = defaultRuntime) {
	if (err instanceof PortInUseError || isErrno(err) && err.code === "EADDRINUSE") {
		const details = err instanceof PortInUseError ? err.details ?? await describePortOwner(port) : await describePortOwner(port);
		runtime.error(danger(`${context} failed: port ${port} is already in use.`));
		if (details) {
			runtime.error(info("Port listener details:"));
			runtime.error(details);
			if (/openclaw|src\/index\.ts|dist\/index\.js/.test(details)) runtime.error(warn("It looks like another OpenClaw instance is already running. Stop it or pick a different port."));
		}
		runtime.error(info("Resolve by stopping the process using the port or passing --port <free-port>."));
		runtime.exit(1);
	}
	runtime.error(danger(`${context} failed: ${String(err)}`));
	if (shouldLogVerbose()) {
		const stdout = err?.stdout;
		const stderr = err?.stderr;
		if (stdout?.trim()) logDebug(`stdout: ${stdout.trim()}`);
		if (stderr?.trim()) logDebug(`stderr: ${stderr.trim()}`);
	}
	runtime.exit(1);
	throw new Error("unreachable");
}
//#endregion
export { inspectPortConnections as a, classifyPortListener as c, isExpectedGatewayListeners as d, isSingleExpectedGatewayListener as f, handlePortError as i, formatPortDiagnostics as l, describePortOwner as n, inspectPortUsage as o, ensurePortAvailable as r, buildPortHints as s, PortInUseError as t, isDualStackLoopbackGatewayListeners as u };
