import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./theme-D58JpUfy.js";
import "./runtime-yzlkhCoS.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import "./prompt-BsiHocog.js";
import { i as runExec } from "./exec-D4bhAbbv.js";
import "./binaries-FMFnzXb3.js";
import { existsSync } from "node:fs";
//#region src/infra/tailscale.ts
function parsePossiblyNoisyJsonObject(stdout) {
	const trimmed = stdout.trim();
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
	return JSON.parse(trimmed);
}
/**
* Locate Tailscale binary using multiple strategies:
* 1. PATH lookup (via which command)
* 2. Known macOS app path
* 3. find /Applications for Tailscale.app
* 4. locate database (if available)
*
* @returns Path to Tailscale binary or null if not found
*/
async function findTailscaleBinary() {
	const checkBinary = async (path) => {
		if (!path || !existsSync(path)) return false;
		try {
			await Promise.race([runExec(path, ["--version"], { timeoutMs: 3e3 }), new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error("timeout")), 3e3))]);
			return true;
		} catch {
			return false;
		}
	};
	try {
		const { stdout } = await runExec("which", ["tailscale"]);
		const fromPath = stdout.trim();
		if (fromPath && await checkBinary(fromPath)) return fromPath;
	} catch {}
	const macAppPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
	if (await checkBinary(macAppPath)) return macAppPath;
	try {
		const { stdout } = await runExec("find", [
			"/Applications",
			"-maxdepth",
			"3",
			"-name",
			"Tailscale",
			"-path",
			"*/Tailscale.app/Contents/MacOS/Tailscale"
		], { timeoutMs: 5e3 });
		const found = stdout.trim().split("\n")[0];
		if (found && await checkBinary(found)) return found;
	} catch {}
	try {
		const { stdout } = await runExec("locate", ["Tailscale.app"]);
		const candidates = stdout.trim().split("\n").filter((line) => line.includes("/Tailscale.app/Contents/MacOS/Tailscale"));
		for (const candidate of candidates) if (await checkBinary(candidate)) return candidate;
	} catch {}
	return null;
}
async function getTailnetHostname(exec = runExec, detectedBinary) {
	const candidates = detectedBinary ? [detectedBinary] : ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
	let lastError;
	for (const candidate of candidates) {
		if (candidate.startsWith("/") && !existsSync(candidate)) continue;
		try {
			const { stdout } = await exec(candidate, ["status", "--json"], {
				timeoutMs: 5e3,
				maxBuffer: 4e5
			});
			const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
			const self = typeof parsed.Self === "object" && parsed.Self !== null ? parsed.Self : void 0;
			const dns = typeof self?.DNSName === "string" ? self.DNSName : void 0;
			const ips = Array.isArray(self?.TailscaleIPs) ? parsed.Self.TailscaleIPs ?? [] : [];
			if (dns && dns.length > 0) return dns.replace(/\.$/, "");
			if (ips.length > 0) return ips[0];
			throw new Error("Could not determine Tailscale DNS or IP");
		} catch (err) {
			lastError = err;
		}
	}
	throw lastError ?? /* @__PURE__ */ new Error("Could not determine Tailscale DNS or IP");
}
/**
* Get the Tailscale binary command to use.
* Returns a cached detected binary or the default "tailscale" command.
*/
let cachedTailscaleBinary = null;
function getTestTailscaleBinaryOverride(env = process.env) {
	const forcedBinary = env.OPENCLAW_TEST_TAILSCALE_BINARY?.trim();
	if (!forcedBinary) return null;
	if (env.VITEST || env.NODE_ENV === "test") return forcedBinary;
	return null;
}
async function getTailscaleBinary() {
	const forcedBinary = getTestTailscaleBinaryOverride();
	if (forcedBinary) {
		cachedTailscaleBinary = forcedBinary;
		return forcedBinary;
	}
	if (cachedTailscaleBinary) return cachedTailscaleBinary;
	cachedTailscaleBinary = await findTailscaleBinary();
	return cachedTailscaleBinary ?? "tailscale";
}
const whoisCache = /* @__PURE__ */ new Map();
function extractExecErrorText(err) {
	const errOutput = err;
	return {
		stdout: typeof errOutput.stdout === "string" ? errOutput.stdout : "",
		stderr: typeof errOutput.stderr === "string" ? errOutput.stderr : "",
		message: typeof errOutput.message === "string" ? errOutput.message : "",
		code: typeof errOutput.code === "string" ? errOutput.code : ""
	};
}
function isPermissionDeniedError(err) {
	const { stdout, stderr, message, code } = extractExecErrorText(err);
	if (code.toUpperCase() === "EACCES") return true;
	const combined = normalizeLowercaseStringOrEmpty(`${stdout}\n${stderr}\n${message}`);
	return combined.includes("permission denied") || combined.includes("access denied") || combined.includes("operation not permitted") || combined.includes("not permitted") || combined.includes("requires root") || combined.includes("must be run as root") || combined.includes("must be run with sudo") || combined.includes("requires sudo") || combined.includes("need sudo");
}
async function execWithSudoFallback(exec, bin, args, opts) {
	try {
		return await exec(bin, args, opts);
	} catch (err) {
		if (!isPermissionDeniedError(err)) throw err;
		logVerbose(`Command failed, retrying with sudo: ${bin} ${args.join(" ")}`);
		try {
			return await exec("sudo", [
				"-n",
				bin,
				...args
			], opts);
		} catch (sudoErr) {
			const { stderr, message } = extractExecErrorText(sudoErr);
			const detail = (stderr || message).trim();
			if (detail) logVerbose(`Sudo retry failed: ${detail}`);
			throw err;
		}
	}
}
async function enableTailscaleServe(port, exec = runExec) {
	await execWithSudoFallback(exec, await getTailscaleBinary(), [
		"serve",
		"--bg",
		"--yes",
		`${port}`
	], {
		maxBuffer: 2e5,
		timeoutMs: 15e3
	});
}
async function hasTailscaleFunnelRouteForPort(port, exec = runExec) {
	try {
		const { stdout } = await exec(await getTailscaleBinary(), [
			"funnel",
			"status",
			"--json"
		], {
			maxBuffer: 2e5,
			timeoutMs: 5e3
		});
		return tailscaleFunnelStatusCoversPort(stdout ? parsePossiblyNoisyJsonObject(stdout) : {}, port);
	} catch {
		return false;
	}
}
const TAILSCALE_LOOPBACK_PROXY_HOSTS = new Set([
	"127.0.0.1",
	"localhost",
	"[::1]",
	"::1"
]);
function tailscaleFunnelStatusCoversPort(status, port) {
	for (const proxy of funnelStatusBackendsForPort(status)) if (tailscaleProxyMatchesLoopbackPort(proxy, port)) return true;
	return false;
}
function tailscaleProxyMatchesLoopbackPort(proxy, port) {
	const stripped = proxy.replace(/^[a-z][a-z0-9+\-.]*:\/\//i, "").replace(/\/.*$/, "");
	if (stripped === String(port)) return true;
	const sep = stripped.lastIndexOf(":");
	if (sep < 0) return false;
	const host = stripped.slice(0, sep);
	if (stripped.slice(sep + 1) !== String(port)) return false;
	return TAILSCALE_LOOPBACK_PROXY_HOSTS.has(host);
}
function funnelStatusBackendsForPort(status) {
	const backends = /* @__PURE__ */ new Set();
	const allowFunnel = status.AllowFunnel ?? {};
	const enabledHosts = new Set(Object.entries(allowFunnel).filter(([, value]) => value === true).map(([host]) => host));
	if (enabledHosts.size === 0) return backends;
	const web = status.Web;
	if (!web || typeof web !== "object") return backends;
	for (const [host, handlers] of Object.entries(web)) {
		if (!enabledHosts.has(host)) continue;
		if (!handlers || typeof handlers !== "object") continue;
		const handlerEntries = handlers.Handlers;
		if (!handlerEntries || typeof handlerEntries !== "object") continue;
		for (const handler of Object.values(handlerEntries)) {
			const proxy = handler?.Proxy;
			if (typeof proxy === "string" && proxy.length > 0) backends.add(proxy);
		}
	}
	return backends;
}
async function disableTailscaleServe(exec = runExec) {
	await execWithSudoFallback(exec, await getTailscaleBinary(), ["serve", "reset"], {
		maxBuffer: 2e5,
		timeoutMs: 15e3
	});
}
async function enableTailscaleFunnel(port, exec = runExec) {
	await execWithSudoFallback(exec, await getTailscaleBinary(), [
		"funnel",
		"--bg",
		"--yes",
		`${port}`
	], {
		maxBuffer: 2e5,
		timeoutMs: 15e3
	});
}
async function disableTailscaleFunnel(exec = runExec) {
	await execWithSudoFallback(exec, await getTailscaleBinary(), ["funnel", "reset"], {
		maxBuffer: 2e5,
		timeoutMs: 15e3
	});
}
function readRecord(value) {
	return value && typeof value === "object" ? value : null;
}
function parseWhoisIdentity(payload) {
	const userProfile = readRecord(payload.UserProfile) ?? readRecord(payload.userProfile) ?? readRecord(payload.User);
	const login = normalizeOptionalString(userProfile?.LoginName) ?? normalizeOptionalString(userProfile?.Login) ?? normalizeOptionalString(userProfile?.login) ?? normalizeOptionalString(payload.LoginName) ?? normalizeOptionalString(payload.login);
	if (!login) return null;
	return {
		login,
		name: normalizeOptionalString(userProfile?.DisplayName) ?? normalizeOptionalString(userProfile?.Name) ?? normalizeOptionalString(userProfile?.displayName) ?? normalizeOptionalString(payload.DisplayName) ?? normalizeOptionalString(payload.name)
	};
}
function readCachedWhois(ip, now) {
	const cached = whoisCache.get(ip);
	if (!cached) return;
	if (cached.expiresAt <= now) {
		whoisCache.delete(ip);
		return;
	}
	return cached.value;
}
function writeCachedWhois(ip, value, ttlMs) {
	whoisCache.set(ip, {
		value,
		expiresAt: Date.now() + ttlMs
	});
}
async function readTailscaleWhoisIdentity(ip, exec = runExec, opts) {
	const normalized = ip.trim();
	if (!normalized) return null;
	const cached = readCachedWhois(normalized, Date.now());
	if (cached !== void 0) return cached;
	const cacheTtlMs = opts?.cacheTtlMs ?? 6e4;
	const errorTtlMs = opts?.errorTtlMs ?? 5e3;
	try {
		const { stdout } = await exec(await getTailscaleBinary(), [
			"whois",
			"--json",
			normalized
		], {
			timeoutMs: opts?.timeoutMs ?? 5e3,
			maxBuffer: 2e5
		});
		const identity = parseWhoisIdentity(stdout ? parsePossiblyNoisyJsonObject(stdout) : {});
		writeCachedWhois(normalized, identity, cacheTtlMs);
		return identity;
	} catch {
		writeCachedWhois(normalized, null, errorTtlMs);
		return null;
	}
}
//#endregion
export { findTailscaleBinary as a, readTailscaleWhoisIdentity as c, enableTailscaleServe as i, disableTailscaleServe as n, getTailnetHostname as o, enableTailscaleFunnel as r, hasTailscaleFunnelRouteForPort as s, disableTailscaleFunnel as t };
