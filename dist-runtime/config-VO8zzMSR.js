import { a as logVerbose, i as isYes, r as isVerbose } from "./globals-I5DlBD2D.js";
import { u as resolveGatewayPort } from "./paths-1qR_mW4i.js";
import { l as defaultRuntime } from "./subsystem-EnljYYs1.js";
import { D as isPlainObject, y as resolveUserPath } from "./utils-Do8MzKyM.js";
import { a as hasConfiguredSecretInput, d as resolveSecretInputRef } from "./types.secrets-CgNgVfYE.js";
import { n as runExec } from "./exec-Fh3CK0qE.js";
import { a as isLoopbackHost, d as resolveClientIp, i as isLoopbackAddress, m as resolveRequestClientIp, r as isLocalishHost, s as isTrustedProxyAddress } from "./device-metadata-normalization-a2oQYp64.js";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import readline from "node:readline/promises";
//#region src/config/env-substitution.ts
/**
* Environment variable substitution for config values.
*
* Supports `${VAR_NAME}` syntax in string values, substituted at config load time.
* - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
* - Escape with `$${}` to output literal `${}`
* - Missing env vars throw `MissingEnvVarError` with context
*
* @example
* ```json5
* {
*   models: {
*     providers: {
*       "vercel-gateway": {
*         apiKey: "${VERCEL_GATEWAY_API_KEY}"
*       }
*     }
*   }
* }
* ```
*/
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
var MissingEnvVarError = class extends Error {
	constructor(varName, configPath) {
		super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
		this.varName = varName;
		this.configPath = configPath;
		this.name = "MissingEnvVarError";
	}
};
function parseEnvTokenAt(value, index) {
	if (value[index] !== "$") {return null;}
	const next = value[index + 1];
	const afterNext = value[index + 2];
	if (next === "$" && afterNext === "{") {
		const start = index + 3;
		const end = value.indexOf("}", start);
		if (end !== -1) {
			const name = value.slice(start, end);
			if (ENV_VAR_NAME_PATTERN.test(name)) {return {
				kind: "escaped",
				name,
				end
			};}
		}
	}
	if (next === "{") {
		const start = index + 2;
		const end = value.indexOf("}", start);
		if (end !== -1) {
			const name = value.slice(start, end);
			if (ENV_VAR_NAME_PATTERN.test(name)) {return {
				kind: "substitution",
				name,
				end
			};}
		}
	}
	return null;
}
function substituteString(value, env, configPath, opts) {
	if (!value.includes("$")) {return value;}
	const chunks = [];
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		if (char !== "$") {
			chunks.push(char);
			continue;
		}
		const token = parseEnvTokenAt(value, i);
		if (token?.kind === "escaped") {
			chunks.push(`\${${token.name}}`);
			i = token.end;
			continue;
		}
		if (token?.kind === "substitution") {
			const envValue = env[token.name];
			if (envValue === void 0 || envValue === "") {
				if (opts?.onMissing) {
					opts.onMissing({
						varName: token.name,
						configPath
					});
					chunks.push(`\${${token.name}}`);
					i = token.end;
					continue;
				}
				throw new MissingEnvVarError(token.name, configPath);
			}
			chunks.push(envValue);
			i = token.end;
			continue;
		}
		chunks.push(char);
	}
	return chunks.join("");
}
function containsEnvVarReference(value) {
	if (!value.includes("$")) {return false;}
	for (let i = 0; i < value.length; i += 1) {
		if (value[i] !== "$") {continue;}
		const token = parseEnvTokenAt(value, i);
		if (token?.kind === "escaped") {
			i = token.end;
			continue;
		}
		if (token?.kind === "substitution") {return true;}
	}
	return false;
}
function substituteAny(value, env, path, opts) {
	if (typeof value === "string") {return substituteString(value, env, path, opts);}
	if (Array.isArray(value)) {return value.map((item, index) => substituteAny(item, env, `${path}[${index}]`, opts));}
	if (isPlainObject(value)) {
		const result = {};
		for (const [key, val] of Object.entries(value)) {result[key] = substituteAny(val, env, path ? `${path}.${key}` : key, opts);}
		return result;
	}
	return value;
}
/**
* Resolves `${VAR_NAME}` environment variable references in config values.
*
* @param obj - The parsed config object (after JSON5 parse and $include resolution)
* @param env - Environment variables to use for substitution (defaults to process.env)
* @param opts - Options: `onMissing` callback to collect warnings instead of throwing.
* @returns The config object with env vars substituted
* @throws {MissingEnvVarError} If a referenced env var is not set or empty (unless `onMissing` is set)
*/
function resolveConfigEnvVars(obj, env = process.env, opts) {
	return substituteAny(obj, env, "", opts);
}
//#endregion
//#region src/browser/constants.ts
const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 8e4;
const DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS = 1e4;
//#endregion
//#region src/cli/prompt.ts
async function promptYesNo(question, defaultYes = false) {
	if (isVerbose() && isYes()) {return true;}
	if (isYes()) {return true;}
	const rl = readline.createInterface({
		input: stdin,
		output: stdout
	});
	const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
	const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
	rl.close();
	if (!answer) {return defaultYes;}
	return answer.startsWith("y");
}
//#endregion
//#region src/infra/binaries.ts
async function ensureBinary(name, exec = runExec, runtime = defaultRuntime) {
	await exec("which", [name]).catch(() => {
		runtime.error(`Missing required binary: ${name}. Please install it.`);
		runtime.exit(1);
	});
}
//#endregion
//#region src/infra/tailscale.ts
function parsePossiblyNoisyJsonObject(stdout) {
	const trimmed = stdout.trim();
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) {return JSON.parse(trimmed.slice(start, end + 1));}
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
		if (!path || !existsSync(path)) {return false;}
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
		if (fromPath && await checkBinary(fromPath)) {return fromPath;}
	} catch {}
	const macAppPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
	if (await checkBinary(macAppPath)) {return macAppPath;}
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
		if (found && await checkBinary(found)) {return found;}
	} catch {}
	try {
		const { stdout } = await runExec("locate", ["Tailscale.app"]);
		const candidates = stdout.trim().split("\n").filter((line) => line.includes("/Tailscale.app/Contents/MacOS/Tailscale"));
		for (const candidate of candidates) {if (await checkBinary(candidate)) return candidate;}
	} catch {}
	return null;
}
async function getTailnetHostname(exec = runExec, detectedBinary) {
	const candidates = detectedBinary ? [detectedBinary] : ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
	let lastError;
	for (const candidate of candidates) {
		if (candidate.startsWith("/") && !existsSync(candidate)) {continue;}
		try {
			const { stdout } = await exec(candidate, ["status", "--json"], {
				timeoutMs: 5e3,
				maxBuffer: 4e5
			});
			const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
			const self = typeof parsed.Self === "object" && parsed.Self !== null ? parsed.Self : void 0;
			const dns = typeof self?.DNSName === "string" ? self.DNSName : void 0;
			const ips = Array.isArray(self?.TailscaleIPs) ? parsed.Self.TailscaleIPs ?? [] : [];
			if (dns && dns.length > 0) {return dns.replace(/\.$/, "");}
			if (ips.length > 0) {return ips[0];}
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
async function getTailscaleBinary() {
	const forcedBinary = process.env.OPENCLAW_TEST_TAILSCALE_BINARY?.trim();
	if (forcedBinary) {
		cachedTailscaleBinary = forcedBinary;
		return forcedBinary;
	}
	if (cachedTailscaleBinary) {return cachedTailscaleBinary;}
	cachedTailscaleBinary = await findTailscaleBinary();
	return cachedTailscaleBinary ?? "tailscale";
}
async function readTailscaleStatusJson(exec = runExec, opts) {
	const { stdout } = await exec(await getTailscaleBinary(), ["status", "--json"], {
		timeoutMs: opts?.timeoutMs ?? 5e3,
		maxBuffer: 4e5
	});
	return stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
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
	if (code.toUpperCase() === "EACCES") {return true;}
	const combined = `${stdout}\n${stderr}\n${message}`.toLowerCase();
	return combined.includes("permission denied") || combined.includes("access denied") || combined.includes("operation not permitted") || combined.includes("not permitted") || combined.includes("requires root") || combined.includes("must be run as root") || combined.includes("must be run with sudo") || combined.includes("requires sudo") || combined.includes("need sudo");
}
async function execWithSudoFallback(exec, bin, args, opts) {
	try {
		return await exec(bin, args, opts);
	} catch (err) {
		if (!isPermissionDeniedError(err)) {throw err;}
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
			if (detail) {logVerbose(`Sudo retry failed: ${detail}`);}
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
function getString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readRecord(value) {
	return value && typeof value === "object" ? value : null;
}
function parseWhoisIdentity(payload) {
	const userProfile = readRecord(payload.UserProfile) ?? readRecord(payload.userProfile) ?? readRecord(payload.User);
	const login = getString(userProfile?.LoginName) ?? getString(userProfile?.Login) ?? getString(userProfile?.login) ?? getString(payload.LoginName) ?? getString(payload.login);
	if (!login) {return null;}
	return {
		login,
		name: getString(userProfile?.DisplayName) ?? getString(userProfile?.Name) ?? getString(userProfile?.displayName) ?? getString(payload.DisplayName) ?? getString(payload.name)
	};
}
function readCachedWhois(ip, now) {
	const cached = whoisCache.get(ip);
	if (!cached) {return;}
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
	if (!normalized) {return null;}
	const cached = readCachedWhois(normalized, Date.now());
	if (cached !== void 0) {return cached;}
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
//#region src/security/secret-equal.ts
function safeEqualSecret(provided, expected) {
	if (typeof provided !== "string" || typeof expected !== "string") {return false;}
	const hash = (s) => createHash("sha256").update(s).digest();
	return timingSafeEqual(hash(provided), hash(expected));
}
const AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET = "shared-secret";
const AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN = "device-token";
const AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH = "hook-auth";
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_WINDOW_MS = 6e4;
const DEFAULT_LOCKOUT_MS = 3e5;
const PRUNE_INTERVAL_MS = 6e4;
/**
* Canonicalize client IPs used for auth throttling so all call sites
* share one representation (including IPv4-mapped IPv6 forms).
*/
function normalizeRateLimitClientIp(ip) {
	return resolveClientIp({ remoteAddr: ip }) ?? "unknown";
}
function createAuthRateLimiter(config) {
	const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
	const lockoutMs = config?.lockoutMs ?? DEFAULT_LOCKOUT_MS;
	const exemptLoopback = config?.exemptLoopback ?? true;
	const pruneIntervalMs = config?.pruneIntervalMs ?? PRUNE_INTERVAL_MS;
	const entries = /* @__PURE__ */ new Map();
	const pruneTimer = pruneIntervalMs > 0 ? setInterval(() => prune(), pruneIntervalMs) : null;
	if (pruneTimer?.unref) {pruneTimer.unref();}
	function normalizeScope(scope) {
		return (scope ?? "default").trim() || "default";
	}
	function normalizeIp(ip) {
		return normalizeRateLimitClientIp(ip);
	}
	function resolveKey(rawIp, rawScope) {
		const ip = normalizeIp(rawIp);
		return {
			key: `${normalizeScope(rawScope)}:${ip}`,
			ip
		};
	}
	function isExempt(ip) {
		return exemptLoopback && isLoopbackAddress(ip);
	}
	function slideWindow(entry, now) {
		const cutoff = now - windowMs;
		entry.attempts = entry.attempts.filter((ts) => ts > cutoff);
	}
	function check(rawIp, rawScope) {
		const { key, ip } = resolveKey(rawIp, rawScope);
		if (isExempt(ip)) {return {
			allowed: true,
			remaining: maxAttempts,
			retryAfterMs: 0
		};}
		const now = Date.now();
		const entry = entries.get(key);
		if (!entry) {return {
			allowed: true,
			remaining: maxAttempts,
			retryAfterMs: 0
		};}
		if (entry.lockedUntil && now < entry.lockedUntil) {return {
			allowed: false,
			remaining: 0,
			retryAfterMs: entry.lockedUntil - now
		};}
		if (entry.lockedUntil && now >= entry.lockedUntil) {
			entry.lockedUntil = void 0;
			entry.attempts = [];
		}
		slideWindow(entry, now);
		const remaining = Math.max(0, maxAttempts - entry.attempts.length);
		return {
			allowed: remaining > 0,
			remaining,
			retryAfterMs: 0
		};
	}
	function recordFailure(rawIp, rawScope) {
		const { key, ip } = resolveKey(rawIp, rawScope);
		if (isExempt(ip)) {return;}
		const now = Date.now();
		let entry = entries.get(key);
		if (!entry) {
			entry = { attempts: [] };
			entries.set(key, entry);
		}
		if (entry.lockedUntil && now < entry.lockedUntil) {return;}
		slideWindow(entry, now);
		entry.attempts.push(now);
		if (entry.attempts.length >= maxAttempts) {entry.lockedUntil = now + lockoutMs;}
	}
	function reset(rawIp, rawScope) {
		const { key } = resolveKey(rawIp, rawScope);
		entries.delete(key);
	}
	function prune() {
		const now = Date.now();
		for (const [key, entry] of entries) {
			if (entry.lockedUntil && now < entry.lockedUntil) {continue;}
			slideWindow(entry, now);
			if (entry.attempts.length === 0) {entries.delete(key);}
		}
	}
	function size() {
		return entries.size;
	}
	function dispose() {
		if (pruneTimer) {clearInterval(pruneTimer);}
		entries.clear();
	}
	return {
		check,
		recordFailure,
		reset,
		size,
		prune,
		dispose
	};
}
//#endregion
//#region src/gateway/credential-planner.ts
function readGatewayEnv(env, names, includeLegacyEnv) {
	const keys = includeLegacyEnv ? names : names.slice(0, 1);
	for (const name of keys) {
		const value = trimToUndefined(env[name]);
		if (value) {return value;}
	}
}
function trimToUndefined(value) {
	if (typeof value !== "string") {return;}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
/**
* Like trimToUndefined but also rejects unresolved env var placeholders (e.g. `${VAR}`).
* This prevents literal placeholder strings like `${OPENCLAW_GATEWAY_TOKEN}` from being
* accepted as valid credentials when the referenced env var is missing.
* Note: legitimate credential values containing literal `${UPPER_CASE}` patterns will
* also be rejected, but this is an extremely unlikely edge case.
*/
function trimCredentialToUndefined(value) {
	const trimmed = trimToUndefined(value);
	if (trimmed && containsEnvVarReference(trimmed)) {return;}
	return trimmed;
}
function readGatewayTokenEnv(env = process.env, includeLegacyEnv = true) {
	return readGatewayEnv(env, ["OPENCLAW_GATEWAY_TOKEN", "CLAWDBOT_GATEWAY_TOKEN"], includeLegacyEnv);
}
function readGatewayPasswordEnv(env = process.env, includeLegacyEnv = true) {
	return readGatewayEnv(env, ["OPENCLAW_GATEWAY_PASSWORD", "CLAWDBOT_GATEWAY_PASSWORD"], includeLegacyEnv);
}
function hasGatewayTokenEnvCandidate(env = process.env, includeLegacyEnv = true) {
	return Boolean(readGatewayTokenEnv(env, includeLegacyEnv));
}
function hasGatewayPasswordEnvCandidate(env = process.env, includeLegacyEnv = true) {
	return Boolean(readGatewayPasswordEnv(env, includeLegacyEnv));
}
function resolveConfiguredGatewayCredentialInput(params) {
	const ref = resolveSecretInputRef({
		value: params.value,
		defaults: params.defaults
	}).ref;
	return {
		path: params.path,
		configured: hasConfiguredSecretInput(params.value, params.defaults),
		value: ref ? void 0 : trimToUndefined(params.value),
		refPath: ref ? params.path : void 0,
		hasSecretRef: ref !== null
	};
}
function createGatewayCredentialPlan(params) {
	const env = params.env ?? process.env;
	const includeLegacyEnv = params.includeLegacyEnv ?? true;
	const gateway = params.config.gateway;
	const remote = gateway?.remote;
	const defaults = params.defaults ?? params.config.secrets?.defaults;
	const authMode = gateway?.auth?.mode;
	const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
	const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);
	const localToken = resolveConfiguredGatewayCredentialInput({
		value: gateway?.auth?.token,
		defaults,
		path: "gateway.auth.token"
	});
	const localPassword = resolveConfiguredGatewayCredentialInput({
		value: gateway?.auth?.password,
		defaults,
		path: "gateway.auth.password"
	});
	const remoteToken = resolveConfiguredGatewayCredentialInput({
		value: remote?.token,
		defaults,
		path: "gateway.remote.token"
	});
	const remotePassword = resolveConfiguredGatewayCredentialInput({
		value: remote?.password,
		defaults,
		path: "gateway.remote.password"
	});
	const localTokenCanWin = authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy";
	const tokenCanWin = Boolean(envToken || localToken.configured || remoteToken.configured);
	const passwordCanWin = authMode === "password" || authMode !== "token" && authMode !== "none" && authMode !== "trusted-proxy" && !tokenCanWin;
	const localTokenSurfaceActive = localTokenCanWin && !envToken && (authMode === "token" || authMode === void 0 && !(envPassword || localPassword.configured));
	const remoteMode = gateway?.mode === "remote";
	const remoteUrlConfigured = Boolean(trimToUndefined(remote?.url));
	const tailscaleRemoteExposure = gateway?.tailscale?.mode === "serve" || gateway?.tailscale?.mode === "funnel";
	const remoteConfiguredSurface = remoteMode || remoteUrlConfigured || tailscaleRemoteExposure;
	const remoteTokenFallbackActive = localTokenCanWin && !envToken && !localToken.configured;
	const remotePasswordFallbackActive = !envPassword && !localPassword.configured && passwordCanWin;
	return {
		configuredMode: gateway?.mode === "remote" ? "remote" : "local",
		authMode,
		envToken,
		envPassword,
		localToken,
		localPassword,
		remoteToken,
		remotePassword,
		localTokenCanWin,
		localPasswordCanWin: passwordCanWin,
		localTokenSurfaceActive,
		tokenCanWin,
		passwordCanWin,
		remoteMode,
		remoteUrlConfigured,
		tailscaleRemoteExposure,
		remoteConfiguredSurface,
		remoteTokenFallbackActive,
		remoteTokenActive: remoteConfiguredSurface || remoteTokenFallbackActive,
		remotePasswordFallbackActive,
		remotePasswordActive: remoteConfiguredSurface || remotePasswordFallbackActive
	};
}
//#endregion
//#region src/gateway/credentials.ts
const GATEWAY_SECRET_REF_UNAVAILABLE_ERROR_CODE = "GATEWAY_SECRET_REF_UNAVAILABLE";
var GatewaySecretRefUnavailableError = class extends Error {
	constructor(path) {
		super([
			`${path} is configured as a secret reference but is unavailable in this command path.`,
			"Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass explicit --token/--password,",
			"or run a gateway command path that resolves secret references before credential selection."
		].join("\n"));
		this.code = GATEWAY_SECRET_REF_UNAVAILABLE_ERROR_CODE;
		this.name = "GatewaySecretRefUnavailableError";
		this.path = path;
	}
};
function isGatewaySecretRefUnavailableError(error, expectedPath) {
	if (!(error instanceof GatewaySecretRefUnavailableError)) {return false;}
	if (!expectedPath) {return true;}
	return error.path === expectedPath;
}
function firstDefined(values) {
	for (const value of values) {if (value) return value;}
}
function throwUnresolvedGatewaySecretInput(path) {
	throw new GatewaySecretRefUnavailableError(path);
}
function resolveGatewayCredentialsFromValues(params) {
	const env = params.env ?? process.env;
	const includeLegacyEnv = params.includeLegacyEnv ?? true;
	const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
	const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);
	const configToken = trimCredentialToUndefined(params.configToken);
	const configPassword = trimCredentialToUndefined(params.configPassword);
	const tokenPrecedence = params.tokenPrecedence ?? "env-first";
	const passwordPrecedence = params.passwordPrecedence ?? "env-first";
	return {
		token: tokenPrecedence === "config-first" ? firstDefined([configToken, envToken]) : firstDefined([envToken, configToken]),
		password: passwordPrecedence === "config-first" ? firstDefined([configPassword, envPassword]) : firstDefined([envPassword, configPassword])
	};
}
function resolveLocalGatewayCredentials(params) {
	const localResolved = resolveGatewayCredentialsFromValues({
		configToken: params.plan.localToken.configured ? params.plan.localToken.value : params.plan.remoteToken.value,
		configPassword: params.plan.localPassword.configured ? params.plan.localPassword.value : params.plan.remotePassword.value,
		env: params.env,
		includeLegacyEnv: params.includeLegacyEnv,
		tokenPrecedence: params.localTokenPrecedence,
		passwordPrecedence: params.localPasswordPrecedence
	});
	const localPasswordCanWin = params.plan.authMode === "password" || params.plan.authMode !== "token" && params.plan.authMode !== "none" && params.plan.authMode !== "trusted-proxy" && !localResolved.token;
	const localTokenCanWin = params.plan.authMode === "token" || params.plan.authMode !== "password" && params.plan.authMode !== "none" && params.plan.authMode !== "trusted-proxy" && !localResolved.password;
	if (params.plan.localToken.refPath && params.localTokenPrecedence === "config-first" && !params.plan.localToken.value && Boolean(params.plan.envToken) && localTokenCanWin) {throwUnresolvedGatewaySecretInput(params.plan.localToken.refPath);}
	if (params.plan.localPassword.refPath && params.localPasswordPrecedence === "config-first" && !params.plan.localPassword.value && Boolean(params.plan.envPassword) && localPasswordCanWin) {throwUnresolvedGatewaySecretInput(params.plan.localPassword.refPath);}
	if (params.plan.localToken.refPath && !localResolved.token && !params.plan.envToken && localTokenCanWin) {throwUnresolvedGatewaySecretInput(params.plan.localToken.refPath);}
	if (params.plan.localPassword.refPath && !localResolved.password && !params.plan.envPassword && localPasswordCanWin) {throwUnresolvedGatewaySecretInput(params.plan.localPassword.refPath);}
	return localResolved;
}
function resolveRemoteGatewayCredentials(params) {
	const token = params.remoteTokenFallback === "remote-only" ? params.plan.remoteToken.value : params.remoteTokenPrecedence === "env-first" ? firstDefined([
		params.plan.envToken,
		params.plan.remoteToken.value,
		params.plan.localToken.value
	]) : firstDefined([
		params.plan.remoteToken.value,
		params.plan.envToken,
		params.plan.localToken.value
	]);
	const password = params.remotePasswordFallback === "remote-only" ? params.plan.remotePassword.value : params.remotePasswordPrecedence === "env-first" ? firstDefined([
		params.plan.envPassword,
		params.plan.remotePassword.value,
		params.plan.localPassword.value
	]) : firstDefined([
		params.plan.remotePassword.value,
		params.plan.envPassword,
		params.plan.localPassword.value
	]);
	const localTokenFallbackEnabled = params.remoteTokenFallback !== "remote-only";
	const localTokenFallback = params.remoteTokenFallback === "remote-only" ? void 0 : params.plan.localToken.value;
	const localPasswordFallback = params.remotePasswordFallback === "remote-only" ? void 0 : params.plan.localPassword.value;
	if (params.plan.remoteToken.refPath && !token && !params.plan.envToken && !localTokenFallback && !password) {throwUnresolvedGatewaySecretInput(params.plan.remoteToken.refPath);}
	if (params.plan.remotePassword.refPath && !password && !params.plan.envPassword && !localPasswordFallback && !token) {throwUnresolvedGatewaySecretInput(params.plan.remotePassword.refPath);}
	if (params.plan.localToken.refPath && localTokenFallbackEnabled && !token && !password && !params.plan.envToken && !params.plan.remoteToken.value && params.plan.localTokenCanWin) {throwUnresolvedGatewaySecretInput(params.plan.localToken.refPath);}
	return {
		token,
		password
	};
}
function resolveGatewayCredentialsFromConfig(params) {
	const env = params.env ?? process.env;
	const includeLegacyEnv = params.includeLegacyEnv ?? true;
	const explicitToken = trimToUndefined(params.explicitAuth?.token);
	const explicitPassword = trimToUndefined(params.explicitAuth?.password);
	if (explicitToken || explicitPassword) {return {
		token: explicitToken,
		password: explicitPassword
	};}
	if (trimToUndefined(params.urlOverride) && params.urlOverrideSource !== "env") {return {};}
	if (trimToUndefined(params.urlOverride) && params.urlOverrideSource === "env") {return resolveGatewayCredentialsFromValues({
		configToken: void 0,
		configPassword: void 0,
		env,
		includeLegacyEnv,
		tokenPrecedence: "env-first",
		passwordPrecedence: "env-first"
	});}
	const plan = createGatewayCredentialPlan({
		config: params.cfg,
		env,
		includeLegacyEnv
	});
	const mode = params.modeOverride ?? plan.configuredMode;
	const localTokenPrecedence = params.localTokenPrecedence ?? (env.OPENCLAW_SERVICE_KIND === "gateway" ? "config-first" : "env-first");
	const localPasswordPrecedence = params.localPasswordPrecedence ?? "env-first";
	if (mode === "local") {return resolveLocalGatewayCredentials({
		plan,
		env,
		includeLegacyEnv,
		localTokenPrecedence,
		localPasswordPrecedence
	});}
	const remoteTokenFallback = params.remoteTokenFallback ?? "remote-env-local";
	const remotePasswordFallback = params.remotePasswordFallback ?? "remote-env-local";
	return resolveRemoteGatewayCredentials({
		plan,
		remoteTokenPrecedence: params.remoteTokenPrecedence ?? "remote-first",
		remotePasswordPrecedence: params.remotePasswordPrecedence ?? "env-first",
		remoteTokenFallback,
		remotePasswordFallback
	});
}
function resolveGatewayProbeCredentialsFromConfig(params) {
	return resolveGatewayCredentialsFromConfig({
		cfg: params.cfg,
		env: params.env,
		explicitAuth: params.explicitAuth,
		modeOverride: params.mode,
		includeLegacyEnv: false,
		remoteTokenFallback: "remote-only"
	});
}
function resolveGatewayDriftCheckCredentialsFromConfig(params) {
	return resolveGatewayCredentialsFromConfig({
		cfg: params.cfg,
		env: {},
		modeOverride: "local",
		localTokenPrecedence: "config-first"
	});
}
//#endregion
//#region src/gateway/auth.ts
function normalizeLogin(login) {
	return login.trim().toLowerCase();
}
function headerValue(value) {
	return Array.isArray(value) ? value[0] : value;
}
const TAILSCALE_TRUSTED_PROXIES = ["127.0.0.1", "::1"];
function resolveTailscaleClientIp(req) {
	if (!req) {return;}
	return resolveClientIp({
		remoteAddr: req.socket?.remoteAddress ?? "",
		forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
		trustedProxies: [...TAILSCALE_TRUSTED_PROXIES]
	});
}
function isLocalDirectRequest(req, trustedProxies, allowRealIpFallback = false) {
	if (!req) {return false;}
	if (!isLoopbackAddress(resolveRequestClientIp(req, trustedProxies, allowRealIpFallback) ?? "")) {return false;}
	const hasForwarded = Boolean(req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || req.headers?.["x-forwarded-host"]);
	const remoteIsTrustedProxy = isTrustedProxyAddress(req.socket?.remoteAddress, trustedProxies);
	return isLocalishHost(req.headers?.host) && (!hasForwarded || remoteIsTrustedProxy);
}
function getTailscaleUser(req) {
	if (!req) {return null;}
	const login = req.headers["tailscale-user-login"];
	if (typeof login !== "string" || !login.trim()) {return null;}
	const nameRaw = req.headers["tailscale-user-name"];
	const profilePic = req.headers["tailscale-user-profile-pic"];
	const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : login.trim();
	return {
		login: login.trim(),
		name,
		profilePic: typeof profilePic === "string" && profilePic.trim() ? profilePic.trim() : void 0
	};
}
function hasTailscaleProxyHeaders(req) {
	if (!req) {return false;}
	return Boolean(req.headers["x-forwarded-for"] && req.headers["x-forwarded-proto"] && req.headers["x-forwarded-host"]);
}
function isTailscaleProxyRequest(req) {
	if (!req) {return false;}
	return isLoopbackAddress(req.socket?.remoteAddress) && hasTailscaleProxyHeaders(req);
}
async function resolveVerifiedTailscaleUser(params) {
	const { req, tailscaleWhois } = params;
	const tailscaleUser = getTailscaleUser(req);
	if (!tailscaleUser) {return {
		ok: false,
		reason: "tailscale_user_missing"
	};}
	if (!isTailscaleProxyRequest(req)) {return {
		ok: false,
		reason: "tailscale_proxy_missing"
	};}
	const clientIp = resolveTailscaleClientIp(req);
	if (!clientIp) {return {
		ok: false,
		reason: "tailscale_whois_failed"
	};}
	const whois = await tailscaleWhois(clientIp);
	if (!whois?.login) {return {
		ok: false,
		reason: "tailscale_whois_failed"
	};}
	if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) {return {
		ok: false,
		reason: "tailscale_user_mismatch"
	};}
	return {
		ok: true,
		user: {
			login: whois.login,
			name: whois.name ?? tailscaleUser.name,
			profilePic: tailscaleUser.profilePic
		}
	};
}
function resolveGatewayAuth(params) {
	const baseAuthConfig = params.authConfig ?? {};
	const authOverride = params.authOverride ?? void 0;
	const authConfig = { ...baseAuthConfig };
	if (authOverride) {
		if (authOverride.mode !== void 0) {authConfig.mode = authOverride.mode;}
		if (authOverride.token !== void 0) {authConfig.token = authOverride.token;}
		if (authOverride.password !== void 0) {authConfig.password = authOverride.password;}
		if (authOverride.allowTailscale !== void 0) {authConfig.allowTailscale = authOverride.allowTailscale;}
		if (authOverride.rateLimit !== void 0) {authConfig.rateLimit = authOverride.rateLimit;}
		if (authOverride.trustedProxy !== void 0) {authConfig.trustedProxy = authOverride.trustedProxy;}
	}
	const env = params.env ?? process.env;
	const tokenRef = resolveSecretInputRef({ value: authConfig.token }).ref;
	const passwordRef = resolveSecretInputRef({ value: authConfig.password }).ref;
	const resolvedCredentials = resolveGatewayCredentialsFromValues({
		configToken: tokenRef ? void 0 : authConfig.token,
		configPassword: passwordRef ? void 0 : authConfig.password,
		env,
		includeLegacyEnv: false,
		tokenPrecedence: "config-first",
		passwordPrecedence: "config-first"
	});
	const token = resolvedCredentials.token;
	const password = resolvedCredentials.password;
	const trustedProxy = authConfig.trustedProxy;
	let mode;
	let modeSource;
	if (authOverride?.mode !== void 0) {
		mode = authOverride.mode;
		modeSource = "override";
	} else if (authConfig.mode) {
		mode = authConfig.mode;
		modeSource = "config";
	} else if (password) {
		mode = "password";
		modeSource = "password";
	} else if (token) {
		mode = "token";
		modeSource = "token";
	} else {
		mode = "token";
		modeSource = "default";
	}
	const allowTailscale = authConfig.allowTailscale ?? (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");
	return {
		mode,
		modeSource,
		token,
		password,
		allowTailscale,
		trustedProxy
	};
}
function assertGatewayAuthConfigured(auth, rawAuthConfig) {
	if (auth.mode === "token" && !auth.token) {
		if (auth.allowTailscale) {return;}
		throw new Error("gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)");
	}
	if (auth.mode === "password" && !auth.password) {
		if (rawAuthConfig?.password != null && typeof rawAuthConfig.password !== "string") {throw new Error("gateway auth mode is password, but gateway.auth.password contains a provider reference object instead of a resolved string — bootstrap secrets (gateway.auth.password) must be plaintext strings or set via the OPENCLAW_GATEWAY_PASSWORD environment variable because the secrets provider system has not initialised yet at gateway startup");}
		throw new Error("gateway auth mode is password, but no password was configured");
	}
	if (auth.mode === "trusted-proxy") {
		if (!auth.trustedProxy) {throw new Error("gateway auth mode is trusted-proxy, but no trustedProxy config was provided (set gateway.auth.trustedProxy)");}
		if (!auth.trustedProxy.userHeader || auth.trustedProxy.userHeader.trim() === "") {throw new Error("gateway auth mode is trusted-proxy, but trustedProxy.userHeader is empty (set gateway.auth.trustedProxy.userHeader)");}
	}
}
/**
* Check if the request came from a trusted proxy and extract user identity.
* Returns the user identity if valid, or null with a reason if not.
*/
function authorizeTrustedProxy(params) {
	const { req, trustedProxies, trustedProxyConfig } = params;
	if (!req) {return { reason: "trusted_proxy_no_request" };}
	const remoteAddr = req.socket?.remoteAddress;
	if (!remoteAddr || !isTrustedProxyAddress(remoteAddr, trustedProxies)) {return { reason: "trusted_proxy_untrusted_source" };}
	const requiredHeaders = trustedProxyConfig.requiredHeaders ?? [];
	for (const header of requiredHeaders) {
		const value = headerValue(req.headers[header.toLowerCase()]);
		if (!value || value.trim() === "") {return { reason: `trusted_proxy_missing_header_${header}` };}
	}
	const userHeaderValue = headerValue(req.headers[trustedProxyConfig.userHeader.toLowerCase()]);
	if (!userHeaderValue || userHeaderValue.trim() === "") {return { reason: "trusted_proxy_user_missing" };}
	const user = userHeaderValue.trim();
	const allowUsers = trustedProxyConfig.allowUsers ?? [];
	if (allowUsers.length > 0 && !allowUsers.includes(user)) {return { reason: "trusted_proxy_user_not_allowed" };}
	return { user };
}
function shouldAllowTailscaleHeaderAuth(authSurface) {
	return authSurface === "ws-control-ui";
}
async function authorizeGatewayConnect(params) {
	const { auth, connectAuth, req, trustedProxies } = params;
	const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
	const allowTailscaleHeaderAuth = shouldAllowTailscaleHeaderAuth(params.authSurface ?? "http");
	const localDirect = isLocalDirectRequest(req, trustedProxies, params.allowRealIpFallback === true);
	if (auth.mode === "trusted-proxy") {
		if (!auth.trustedProxy) {return {
			ok: false,
			reason: "trusted_proxy_config_missing"
		};}
		if (!trustedProxies || trustedProxies.length === 0) {return {
			ok: false,
			reason: "trusted_proxy_no_proxies_configured"
		};}
		const result = authorizeTrustedProxy({
			req,
			trustedProxies,
			trustedProxyConfig: auth.trustedProxy
		});
		if ("user" in result) {return {
			ok: true,
			method: "trusted-proxy",
			user: result.user
		};}
		return {
			ok: false,
			reason: result.reason
		};
	}
	if (auth.mode === "none") {return {
		ok: true,
		method: "none"
	};}
	const limiter = params.rateLimiter;
	const ip = params.clientIp ?? resolveRequestClientIp(req, trustedProxies, params.allowRealIpFallback === true) ?? req?.socket?.remoteAddress;
	const rateLimitScope = params.rateLimitScope ?? "shared-secret";
	if (limiter) {
		const rlCheck = limiter.check(ip, rateLimitScope);
		if (!rlCheck.allowed) {return {
			ok: false,
			reason: "rate_limited",
			rateLimited: true,
			retryAfterMs: rlCheck.retryAfterMs
		};}
	}
	if (allowTailscaleHeaderAuth && auth.allowTailscale && !localDirect) {
		const tailscaleCheck = await resolveVerifiedTailscaleUser({
			req,
			tailscaleWhois
		});
		if (tailscaleCheck.ok) {
			limiter?.reset(ip, rateLimitScope);
			return {
				ok: true,
				method: "tailscale",
				user: tailscaleCheck.user.login
			};
		}
	}
	if (auth.mode === "token") {
		if (!auth.token) {return {
			ok: false,
			reason: "token_missing_config"
		};}
		if (!connectAuth?.token) {return {
			ok: false,
			reason: "token_missing"
		};}
		if (!safeEqualSecret(connectAuth.token, auth.token)) {
			limiter?.recordFailure(ip, rateLimitScope);
			return {
				ok: false,
				reason: "token_mismatch"
			};
		}
		limiter?.reset(ip, rateLimitScope);
		return {
			ok: true,
			method: "token"
		};
	}
	if (auth.mode === "password") {
		const password = connectAuth?.password;
		if (!auth.password) {return {
			ok: false,
			reason: "password_missing_config"
		};}
		if (!password) {return {
			ok: false,
			reason: "password_missing"
		};}
		if (!safeEqualSecret(password, auth.password)) {
			limiter?.recordFailure(ip, rateLimitScope);
			return {
				ok: false,
				reason: "password_mismatch"
			};
		}
		limiter?.reset(ip, rateLimitScope);
		return {
			ok: true,
			method: "password"
		};
	}
	limiter?.recordFailure(ip, rateLimitScope);
	return {
		ok: false,
		reason: "unauthorized"
	};
}
async function authorizeHttpGatewayConnect(params) {
	return authorizeGatewayConnect({
		...params,
		authSurface: "http"
	});
}
async function authorizeWsControlUiGatewayConnect(params) {
	return authorizeGatewayConnect({
		...params,
		authSurface: "ws-control-ui"
	});
}
//#endregion
//#region src/config/port-defaults.ts
function isValidPort(port) {
	return Number.isFinite(port) && port > 0 && port <= 65535;
}
function clampPort(port, fallback) {
	return isValidPort(port) ? port : fallback;
}
function derivePort(base, offset, fallback) {
	return clampPort(base + offset, fallback);
}
const DEFAULT_BROWSER_CONTROL_PORT = 18791;
const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
const DEFAULT_BROWSER_CDP_PORT_RANGE_END = 18899;
function deriveDefaultBrowserControlPort(gatewayPort) {
	return derivePort(gatewayPort, 2, DEFAULT_BROWSER_CONTROL_PORT);
}
function deriveDefaultBrowserCdpPortRange(browserControlPort) {
	const start = derivePort(browserControlPort, 9, DEFAULT_BROWSER_CDP_PORT_RANGE_START);
	const end = clampPort(start + (DEFAULT_BROWSER_CDP_PORT_RANGE_END - DEFAULT_BROWSER_CDP_PORT_RANGE_START), DEFAULT_BROWSER_CDP_PORT_RANGE_END);
	if (end < start) {return {
		start,
		end: start
	};}
	return {
		start,
		end
	};
}
const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;
function isValidProfileName(name) {
	if (!name || name.length > 64) {return false;}
	return PROFILE_NAME_REGEX.test(name);
}
function allocateCdpPort(usedPorts, range) {
	const start = range?.start ?? 18800;
	const end = range?.end ?? 18899;
	if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) {return null;}
	if (start > end) {return null;}
	for (let port = start; port <= end; port++) {if (!usedPorts.has(port)) return port;}
	return null;
}
function getUsedPorts(profiles) {
	if (!profiles) {return /* @__PURE__ */ new Set();}
	const used = /* @__PURE__ */ new Set();
	for (const profile of Object.values(profiles)) {
		if (typeof profile.cdpPort === "number") {
			used.add(profile.cdpPort);
			continue;
		}
		const rawUrl = profile.cdpUrl?.trim();
		if (!rawUrl) {continue;}
		try {
			const parsed = new URL(rawUrl);
			const port = parsed.port && Number.parseInt(parsed.port, 10) > 0 ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
			if (!Number.isNaN(port) && port > 0 && port <= 65535) {used.add(port);}
		} catch {}
	}
	return used;
}
const PROFILE_COLORS = [
	"#FF4500",
	"#0066CC",
	"#00AA00",
	"#9933FF",
	"#FF6699",
	"#00CCCC",
	"#FF9900",
	"#6666FF",
	"#CC3366",
	"#339966"
];
function allocateColor(usedColors) {
	for (const color of PROFILE_COLORS) {if (!usedColors.has(color.toUpperCase())) return color;}
	return PROFILE_COLORS[usedColors.size % PROFILE_COLORS.length] ?? PROFILE_COLORS[0];
}
function getUsedColors(profiles) {
	if (!profiles) {return /* @__PURE__ */ new Set();}
	return new Set(Object.values(profiles).map((p) => p.color.toUpperCase()));
}
//#endregion
//#region src/browser/config.ts
function normalizeHexColor(raw) {
	const value = (raw ?? "").trim();
	if (!value) {return DEFAULT_OPENCLAW_BROWSER_COLOR;}
	const normalized = value.startsWith("#") ? value : `#${value}`;
	if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {return DEFAULT_OPENCLAW_BROWSER_COLOR;}
	return normalized.toUpperCase();
}
function normalizeTimeoutMs(raw, fallback) {
	const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
	return value < 0 ? fallback : value;
}
function resolveCdpPortRangeStart(rawStart, fallbackStart, rangeSpan) {
	const start = typeof rawStart === "number" && Number.isFinite(rawStart) ? Math.floor(rawStart) : fallbackStart;
	if (start < 1 || start > 65535) {throw new Error(`browser.cdpPortRangeStart must be between 1 and 65535, got: ${start}`);}
	const maxStart = 65535 - rangeSpan;
	if (start > maxStart) {throw new Error(`browser.cdpPortRangeStart (${start}) is too high for a ${rangeSpan + 1}-port range; max is ${maxStart}.`);}
	return start;
}
function normalizeStringList(raw) {
	if (!Array.isArray(raw) || raw.length === 0) {return;}
	const values = raw.map((value) => value.trim()).filter((value) => value.length > 0);
	return values.length > 0 ? values : void 0;
}
function resolveBrowserSsrFPolicy(cfg) {
	const allowPrivateNetwork = cfg?.ssrfPolicy?.allowPrivateNetwork;
	const dangerouslyAllowPrivateNetwork = cfg?.ssrfPolicy?.dangerouslyAllowPrivateNetwork;
	const allowedHostnames = normalizeStringList(cfg?.ssrfPolicy?.allowedHostnames);
	const hostnameAllowlist = normalizeStringList(cfg?.ssrfPolicy?.hostnameAllowlist);
	const hasExplicitPrivateSetting = allowPrivateNetwork !== void 0 || dangerouslyAllowPrivateNetwork !== void 0;
	const resolvedAllowPrivateNetwork = dangerouslyAllowPrivateNetwork === true || allowPrivateNetwork === true || !hasExplicitPrivateSetting;
	if (!resolvedAllowPrivateNetwork && !hasExplicitPrivateSetting && !allowedHostnames && !hostnameAllowlist) {return;}
	return {
		...resolvedAllowPrivateNetwork ? { dangerouslyAllowPrivateNetwork: true } : {},
		...allowedHostnames ? { allowedHostnames } : {},
		...hostnameAllowlist ? { hostnameAllowlist } : {}
	};
}
function parseHttpUrl(raw, label) {
	const trimmed = raw.trim();
	const parsed = new URL(trimmed);
	if (![
		"http:",
		"https:",
		"ws:",
		"wss:"
	].includes(parsed.protocol)) {throw new Error(`${label} must be http(s) or ws(s), got: ${parsed.protocol.replace(":", "")}`);}
	const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
	const port = parsed.port && Number.parseInt(parsed.port, 10) > 0 ? Number.parseInt(parsed.port, 10) : isSecure ? 443 : 80;
	if (Number.isNaN(port) || port <= 0 || port > 65535) {throw new Error(`${label} has invalid port: ${parsed.port}`);}
	return {
		parsed,
		port,
		normalized: parsed.toString().replace(/\/$/, "")
	};
}
/**
* Ensure the default "openclaw" profile exists in the profiles map.
* Auto-creates it with the legacy CDP port (from browser.cdpUrl) or first port if missing.
*/
function ensureDefaultProfile(profiles, defaultColor, legacyCdpPort, derivedDefaultCdpPort, legacyCdpUrl) {
	const result = { ...profiles };
	if (!result["openclaw"]) {result[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME] = {
		cdpPort: legacyCdpPort ?? derivedDefaultCdpPort ?? 18800,
		color: defaultColor,
		...legacyCdpUrl ? { cdpUrl: legacyCdpUrl } : {}
	};}
	return result;
}
/**
* Ensure a built-in "user" profile exists for Chrome's existing-session attach flow.
*/
function ensureDefaultUserBrowserProfile(profiles) {
	const result = { ...profiles };
	if (result.user) {return result;}
	result.user = {
		driver: "existing-session",
		attachOnly: true,
		color: "#00AA00"
	};
	return result;
}
function resolveBrowserConfig(cfg, rootConfig) {
	const enabled = cfg?.enabled ?? true;
	const evaluateEnabled = cfg?.evaluateEnabled ?? true;
	const controlPort = deriveDefaultBrowserControlPort(resolveGatewayPort(rootConfig) ?? 18791);
	const defaultColor = normalizeHexColor(cfg?.color);
	const remoteCdpTimeoutMs = normalizeTimeoutMs(cfg?.remoteCdpTimeoutMs, 1500);
	const remoteCdpHandshakeTimeoutMs = normalizeTimeoutMs(cfg?.remoteCdpHandshakeTimeoutMs, Math.max(2e3, remoteCdpTimeoutMs * 2));
	const derivedCdpRange = deriveDefaultBrowserCdpPortRange(controlPort);
	const cdpRangeSpan = derivedCdpRange.end - derivedCdpRange.start;
	const cdpPortRangeStart = resolveCdpPortRangeStart(cfg?.cdpPortRangeStart, derivedCdpRange.start, cdpRangeSpan);
	const cdpPortRangeEnd = cdpPortRangeStart + cdpRangeSpan;
	const rawCdpUrl = (cfg?.cdpUrl ?? "").trim();
	let cdpInfo;
	if (rawCdpUrl) {cdpInfo = parseHttpUrl(rawCdpUrl, "browser.cdpUrl");}
	else {
		const derivedPort = controlPort + 1;
		if (derivedPort > 65535) {throw new Error(`Derived CDP port (${derivedPort}) is too high; check gateway port configuration.`);}
		const derived = new URL(`http://127.0.0.1:${derivedPort}`);
		cdpInfo = {
			parsed: derived,
			port: derivedPort,
			normalized: derived.toString().replace(/\/$/, "")
		};
	}
	const headless = cfg?.headless === true;
	const noSandbox = cfg?.noSandbox === true;
	const attachOnly = cfg?.attachOnly === true;
	const executablePath = cfg?.executablePath?.trim() || void 0;
	const defaultProfileFromConfig = cfg?.defaultProfile?.trim() || void 0;
	const legacyCdpPort = rawCdpUrl ? cdpInfo.port : void 0;
	const isWsUrl = cdpInfo.parsed.protocol === "ws:" || cdpInfo.parsed.protocol === "wss:";
	const legacyCdpUrl = rawCdpUrl && isWsUrl ? cdpInfo.normalized : void 0;
	const profiles = ensureDefaultUserBrowserProfile(ensureDefaultProfile(cfg?.profiles, defaultColor, legacyCdpPort, cdpPortRangeStart, legacyCdpUrl));
	const cdpProtocol = cdpInfo.parsed.protocol === "https:" ? "https" : "http";
	const defaultProfile = defaultProfileFromConfig ?? (profiles["openclaw"] ? "openclaw" : profiles["openclaw"] ? "openclaw" : "user");
	const extraArgs = Array.isArray(cfg?.extraArgs) ? cfg.extraArgs.filter((a) => typeof a === "string" && a.trim().length > 0) : [];
	const ssrfPolicy = resolveBrowserSsrFPolicy(cfg);
	return {
		enabled,
		evaluateEnabled,
		controlPort,
		cdpPortRangeStart,
		cdpPortRangeEnd,
		cdpProtocol,
		cdpHost: cdpInfo.parsed.hostname,
		cdpIsLoopback: isLoopbackHost(cdpInfo.parsed.hostname),
		remoteCdpTimeoutMs,
		remoteCdpHandshakeTimeoutMs,
		color: defaultColor,
		executablePath,
		headless,
		noSandbox,
		attachOnly,
		defaultProfile,
		profiles,
		ssrfPolicy,
		extraArgs
	};
}
/**
* Resolve a profile by name from the config.
* Returns null if the profile doesn't exist.
*/
function resolveProfile(resolved, profileName) {
	const profile = resolved.profiles[profileName];
	if (!profile) {return null;}
	const rawProfileUrl = profile.cdpUrl?.trim() ?? "";
	let cdpHost = resolved.cdpHost;
	let cdpPort = profile.cdpPort ?? 0;
	let cdpUrl = "";
	const driver = profile.driver === "existing-session" ? "existing-session" : "openclaw";
	if (driver === "existing-session") {return {
		name: profileName,
		cdpPort: 0,
		cdpUrl: "",
		cdpHost: "",
		cdpIsLoopback: true,
		userDataDir: resolveUserPath(profile.userDataDir?.trim() || "") || void 0,
		color: profile.color,
		driver,
		attachOnly: true
	};}
	if (rawProfileUrl) {
		const parsed = parseHttpUrl(rawProfileUrl, `browser.profiles.${profileName}.cdpUrl`);
		cdpHost = parsed.parsed.hostname;
		cdpPort = parsed.port;
		cdpUrl = parsed.normalized;
	} else if (cdpPort) {cdpUrl = `${resolved.cdpProtocol}://${resolved.cdpHost}:${cdpPort}`;}
	else {throw new Error(`Profile "${profileName}" must define cdpPort or cdpUrl.`);}
	return {
		name: profileName,
		cdpPort,
		cdpUrl,
		cdpHost,
		cdpIsLoopback: isLoopbackHost(cdpHost),
		color: profile.color,
		driver,
		attachOnly: profile.attachOnly ?? resolved.attachOnly
	};
}
//#endregion
export { normalizeRateLimitClientIp as A, promptYesNo as B, readGatewayPasswordEnv as C, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH as D, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN as E, enableTailscaleServe as F, MissingEnvVarError as G, DEFAULT_AI_SNAPSHOT_MAX_CHARS as H, findTailscaleBinary as I, containsEnvVarReference as K, getTailnetHostname as L, disableTailscaleFunnel as M, disableTailscaleServe as N, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET as O, enableTailscaleFunnel as P, readTailscaleStatusJson as R, hasGatewayTokenEnvCandidate as S, trimToUndefined as T, DEFAULT_OPENCLAW_BROWSER_COLOR as U, DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS as V, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME as W, resolveGatewayCredentialsFromConfig as _, allocateColor as a, createGatewayCredentialPlan as b, isValidProfileName as c, authorizeHttpGatewayConnect as d, authorizeWsControlUiGatewayConnect as f, isGatewaySecretRefUnavailableError as g, GatewaySecretRefUnavailableError as h, allocateCdpPort as i, safeEqualSecret as j, createAuthRateLimiter as k, deriveDefaultBrowserCdpPortRange as l, resolveGatewayAuth as m, resolveBrowserConfig as n, getUsedColors as o, isLocalDirectRequest as p, resolveConfigEnvVars as q, resolveProfile as r, getUsedPorts as s, parseHttpUrl as t, assertGatewayAuthConfigured as u, resolveGatewayDriftCheckCredentialsFromConfig as v, readGatewayTokenEnv as w, hasGatewayPasswordEnvCandidate as x, resolveGatewayProbeCredentialsFromConfig as y, ensureBinary as z };
