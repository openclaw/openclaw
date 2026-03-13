import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import fs$1 from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import process$1 from "node:process";
import { promisify } from "node:util";
import "tslog";
import "json5";
import chalk, { Chalk } from "chalk";
//#region src/shared/device-auth.ts
function normalizeDeviceAuthScopes(scopes) {
	if (!Array.isArray(scopes)) return [];
	const out = /* @__PURE__ */ new Set();
	for (const scope of scopes) {
		const trimmed = scope.trim();
		if (trimmed) out.add(trimmed);
	}
	return [...out].toSorted();
}
//#endregion
//#region src/infra/home-dir.ts
function normalize(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function resolveEffectiveHomeDir(env = process.env, homedir = os.homedir) {
	const raw = resolveRawHomeDir(env, homedir);
	return raw ? path.resolve(raw) : void 0;
}
function resolveRawHomeDir(env, homedir) {
	const explicitHome = normalize(env.OPENCLAW_HOME);
	if (explicitHome) {
		if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
			const fallbackHome = normalize(env.HOME) ?? normalize(env.USERPROFILE) ?? normalizeSafe(homedir);
			if (fallbackHome) return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
			return;
		}
		return explicitHome;
	}
	const envHome = normalize(env.HOME);
	if (envHome) return envHome;
	const userProfile = normalize(env.USERPROFILE);
	if (userProfile) return userProfile;
	return normalizeSafe(homedir);
}
function normalizeSafe(homedir) {
	try {
		return normalize(homedir());
	} catch {
		return;
	}
}
function resolveRequiredHomeDir(env = process.env, homedir = os.homedir) {
	return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
function expandHomePrefix(input, opts) {
	if (!input.startsWith("~")) return input;
	const home = normalize(opts?.home) ?? resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
	if (!home) return input;
	return input.replace(/^~(?=$|[\\/])/, home);
}
//#endregion
//#region src/config/paths.ts
/**
* Nix mode detection: When OPENCLAW_NIX_MODE=1, the gateway is running under Nix.
* In this mode:
* - No auto-install flows should be attempted
* - Missing dependencies should produce actionable Nix-specific error messages
* - Config is managed externally (read-only from Nix perspective)
*/
function resolveIsNixMode(env = process.env) {
	return env.OPENCLAW_NIX_MODE === "1";
}
resolveIsNixMode();
const LEGACY_STATE_DIRNAMES = [
	".clawdbot",
	".moldbot",
	".moltbot"
];
const NEW_STATE_DIRNAME = ".openclaw";
const CONFIG_FILENAME = "openclaw.json";
const LEGACY_CONFIG_FILENAMES = [
	"clawdbot.json",
	"moldbot.json",
	"moltbot.json"
];
function resolveDefaultHomeDir() {
	return resolveRequiredHomeDir(process.env, os.homedir);
}
/** Build a homedir thunk that respects OPENCLAW_HOME for the given env. */
function envHomedir(env) {
	return () => resolveRequiredHomeDir(env, os.homedir);
}
function legacyStateDirs(homedir = resolveDefaultHomeDir) {
	return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}
function newStateDir(homedir = resolveDefaultHomeDir) {
	return path.join(homedir(), NEW_STATE_DIRNAME);
}
/**
* State directory for mutable data (sessions, logs, caches).
* Can be overridden via OPENCLAW_STATE_DIR.
* Default: ~/.openclaw
*/
function resolveStateDir(env = process.env, homedir = envHomedir(env)) {
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (override) return resolveUserPath(override, env, effectiveHomedir);
	const newDir = newStateDir(effectiveHomedir);
	if (env.OPENCLAW_TEST_FAST === "1") return newDir;
	const legacyDirs = legacyStateDirs(effectiveHomedir);
	if (fs.existsSync(newDir)) return newDir;
	const existingLegacy = legacyDirs.find((dir) => {
		try {
			return fs.existsSync(dir);
		} catch {
			return false;
		}
	});
	if (existingLegacy) return existingLegacy;
	return newDir;
}
function resolveUserPath(input, env = process.env, homedir = envHomedir(env)) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		const expanded = expandHomePrefix(trimmed, {
			home: resolveRequiredHomeDir(env, homedir),
			env,
			homedir
		});
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}
resolveStateDir();
/**
* Config file path (JSON5).
* Can be overridden via OPENCLAW_CONFIG_PATH.
* Default: ~/.openclaw/openclaw.json (or $OPENCLAW_STATE_DIR/openclaw.json)
*/
function resolveCanonicalConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env))) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
	if (override) return resolveUserPath(override, env, envHomedir(env));
	return path.join(stateDir, CONFIG_FILENAME);
}
/**
* Resolve the active config path by preferring existing config candidates
* before falling back to the canonical path.
*/
function resolveConfigPathCandidate(env = process.env, homedir = envHomedir(env)) {
	if (env.OPENCLAW_TEST_FAST === "1") return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
	const existing = resolveDefaultConfigCandidates(env, homedir).find((candidate) => {
		try {
			return fs.existsSync(candidate);
		} catch {
			return false;
		}
	});
	if (existing) return existing;
	return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
}
resolveConfigPathCandidate();
/**
* Resolve default config path candidates across default locations.
* Order: explicit config path → state-dir-derived paths → new default.
*/
function resolveDefaultConfigCandidates(env = process.env, homedir = envHomedir(env)) {
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const explicit = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
	if (explicit) return [resolveUserPath(explicit, env, effectiveHomedir)];
	const candidates = [];
	const openclawStateDir = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (openclawStateDir) {
		const resolved = resolveUserPath(openclawStateDir, env, effectiveHomedir);
		candidates.push(path.join(resolved, CONFIG_FILENAME));
		candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(resolved, name)));
	}
	const defaultDirs = [newStateDir(effectiveHomedir), ...legacyStateDirs(effectiveHomedir)];
	for (const dir of defaultDirs) {
		candidates.push(path.join(dir, CONFIG_FILENAME));
		candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(dir, name)));
	}
	return candidates;
}
//#endregion
//#region src/infra/json-files.ts
async function readJsonFile(filePath) {
	try {
		const raw = await fs$1.readFile(filePath, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function writeJsonAtomic(filePath, value, options) {
	await writeTextAtomic(filePath, JSON.stringify(value, null, 2), {
		mode: options?.mode,
		ensureDirMode: options?.ensureDirMode,
		appendTrailingNewline: options?.trailingNewline
	});
}
async function writeTextAtomic(filePath, content, options) {
	const mode = options?.mode ?? 384;
	const payload = options?.appendTrailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
	const mkdirOptions = { recursive: true };
	if (typeof options?.ensureDirMode === "number") mkdirOptions.mode = options.ensureDirMode;
	await fs$1.mkdir(path.dirname(filePath), mkdirOptions);
	const tmp = `${filePath}.${randomUUID()}.tmp`;
	try {
		await fs$1.writeFile(tmp, payload, {
			encoding: "utf8",
			mode
		});
		try {
			await fs$1.chmod(tmp, mode);
		} catch {}
		await fs$1.rename(tmp, filePath);
		try {
			await fs$1.chmod(filePath, mode);
		} catch {}
	} finally {
		await fs$1.rm(tmp, { force: true }).catch(() => void 0);
	}
}
function createAsyncLock() {
	let lock = Promise.resolve();
	return async function withLock(fn) {
		const prev = lock;
		let release;
		lock = new Promise((resolve) => {
			release = resolve;
		});
		await prev;
		try {
			return await fn();
		} finally {
			release?.();
		}
	};
}
//#endregion
//#region src/infra/pairing-files.ts
function resolvePairingPaths(baseDir, subdir) {
	const root = baseDir ?? resolveStateDir();
	const dir = path.join(root, subdir);
	return {
		dir,
		pendingPath: path.join(dir, "pending.json"),
		pairedPath: path.join(dir, "paired.json")
	};
}
function pruneExpiredPending(pendingById, nowMs, ttlMs) {
	for (const [id, req] of Object.entries(pendingById)) if (nowMs - req.ts > ttlMs) delete pendingById[id];
}
function generatePairingToken() {
	return randomBytes(32).toString("base64url");
}
//#endregion
//#region src/infra/device-pairing.ts
const PENDING_TTL_MS = 300 * 1e3;
const withLock$1 = createAsyncLock();
async function loadState$1(baseDir) {
	const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
	const [pending, paired] = await Promise.all([readJsonFile(pendingPath), readJsonFile(pairedPath)]);
	const state = {
		pendingById: pending ?? {},
		pairedByDeviceId: paired ?? {}
	};
	pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
	return state;
}
async function persistState$1(state, baseDir) {
	const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
	await Promise.all([writeJsonAtomic(pendingPath, state.pendingById), writeJsonAtomic(pairedPath, state.pairedByDeviceId)]);
}
function normalizeRole(role) {
	const trimmed = role?.trim();
	return trimmed ? trimmed : null;
}
function mergeRoles(...items) {
	const roles = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!item) continue;
		if (Array.isArray(item)) for (const role of item) {
			const trimmed = role.trim();
			if (trimmed) roles.add(trimmed);
		}
		else {
			const trimmed = item.trim();
			if (trimmed) roles.add(trimmed);
		}
	}
	if (roles.size === 0) return;
	return [...roles];
}
function mergeScopes(...items) {
	const scopes = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!item) continue;
		for (const scope of item) {
			const trimmed = scope.trim();
			if (trimmed) scopes.add(trimmed);
		}
	}
	if (scopes.size === 0) return;
	return [...scopes];
}
function newToken() {
	return generatePairingToken();
}
async function listDevicePairing(baseDir) {
	const state = await loadState$1(baseDir);
	return {
		pending: Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts),
		paired: Object.values(state.pairedByDeviceId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs)
	};
}
async function approveDevicePairing(requestId, baseDir) {
	return await withLock$1(async () => {
		const state = await loadState$1(baseDir);
		const pending = state.pendingById[requestId];
		if (!pending) return null;
		const now = Date.now();
		const existing = state.pairedByDeviceId[pending.deviceId];
		const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
		const approvedScopes = mergeScopes(existing?.approvedScopes ?? existing?.scopes, pending.scopes);
		const tokens = existing?.tokens ? { ...existing.tokens } : {};
		const roleForToken = normalizeRole(pending.role);
		if (roleForToken) {
			const existingToken = tokens[roleForToken];
			const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
			const nextScopes = requestedScopes.length > 0 ? requestedScopes : normalizeDeviceAuthScopes(existingToken?.scopes ?? approvedScopes ?? existing?.approvedScopes ?? existing?.scopes);
			const now = Date.now();
			tokens[roleForToken] = {
				token: newToken(),
				role: roleForToken,
				scopes: nextScopes,
				createdAtMs: existingToken?.createdAtMs ?? now,
				rotatedAtMs: existingToken ? now : void 0,
				revokedAtMs: void 0,
				lastUsedAtMs: existingToken?.lastUsedAtMs
			};
		}
		const device = {
			deviceId: pending.deviceId,
			publicKey: pending.publicKey,
			displayName: pending.displayName,
			platform: pending.platform,
			deviceFamily: pending.deviceFamily,
			clientId: pending.clientId,
			clientMode: pending.clientMode,
			role: pending.role,
			roles,
			scopes: approvedScopes,
			approvedScopes,
			remoteIp: pending.remoteIp,
			tokens,
			createdAtMs: existing?.createdAtMs ?? now,
			approvedAtMs: now
		};
		delete state.pendingById[requestId];
		state.pairedByDeviceId[device.deviceId] = device;
		await persistState$1(state, baseDir);
		return {
			requestId,
			device
		};
	});
}
//#endregion
//#region src/infra/device-bootstrap.ts
const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 600 * 1e3;
const withLock = createAsyncLock();
function resolveBootstrapPath(baseDir) {
	return path.join(resolvePairingPaths(baseDir, "devices").dir, "bootstrap.json");
}
async function loadState(baseDir) {
	const state = await readJsonFile(resolveBootstrapPath(baseDir)) ?? {};
	for (const entry of Object.values(state)) if (typeof entry.ts !== "number") entry.ts = entry.issuedAtMs;
	pruneExpiredPending(state, Date.now(), DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
	return state;
}
async function persistState(state, baseDir) {
	await writeJsonAtomic(resolveBootstrapPath(baseDir), state);
}
async function issueDeviceBootstrapToken(params = {}) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const token = generatePairingToken();
		const issuedAtMs = Date.now();
		state[token] = {
			token,
			ts: issuedAtMs,
			issuedAtMs
		};
		await persistState(state, params.baseDir);
		return {
			token,
			expiresAtMs: issuedAtMs + DEVICE_BOOTSTRAP_TOKEN_TTL_MS
		};
	});
}
//#endregion
//#region src/shared/gateway-bind-url.ts
function resolveGatewayBindUrl(params) {
	const bind = params.bind ?? "loopback";
	if (bind === "custom") {
		const host = params.customBindHost?.trim();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=custom"
		};
		return { error: "gateway.bind=custom requires gateway.customBindHost." };
	}
	if (bind === "tailnet") {
		const host = params.pickTailnetHost();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=tailnet"
		};
		return { error: "gateway.bind=tailnet set, but no tailnet IP was found." };
	}
	if (bind === "lan") {
		const host = params.pickLanHost();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=lan"
		};
		return { error: "gateway.bind=lan set, but no private LAN IP was found." };
	}
	return null;
}
//#endregion
//#region src/shared/tailscale-status.ts
const TAILSCALE_STATUS_COMMAND_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
function parsePossiblyNoisyJsonObject(raw) {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return {};
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch {
		return {};
	}
}
function extractTailnetHostFromStatusJson(raw) {
	const parsed = parsePossiblyNoisyJsonObject(raw);
	const self = typeof parsed.Self === "object" && parsed.Self !== null ? parsed.Self : void 0;
	const dns = typeof self?.DNSName === "string" ? self.DNSName : void 0;
	if (dns && dns.length > 0) return dns.replace(/\.$/, "");
	const ips = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs : [];
	return ips.length > 0 ? ips[0] ?? null : null;
}
async function resolveTailnetHostWithRunner(runCommandWithTimeout) {
	if (!runCommandWithTimeout) return null;
	for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) try {
		const result = await runCommandWithTimeout([
			candidate,
			"status",
			"--json"
		], { timeoutMs: 5e3 });
		if (result.code !== 0) continue;
		const raw = result.stdout.trim();
		if (!raw) continue;
		const host = extractTailnetHostFromStatusJson(raw);
		if (host) return host;
	} catch {
		continue;
	}
	return null;
}
//#endregion
//#region src/infra/tmp-openclaw-dir.ts
const POSIX_OPENCLAW_TMP_DIR = "/tmp/openclaw";
const TMP_DIR_ACCESS_MODE = fs.constants.W_OK | fs.constants.X_OK;
function isNodeErrorWithCode(err, code) {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
function resolvePreferredOpenClawTmpDir(options = {}) {
	const accessSync = options.accessSync ?? fs.accessSync;
	const chmodSync = options.chmodSync ?? fs.chmodSync;
	const lstatSync = options.lstatSync ?? fs.lstatSync;
	const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
	const warn = options.warn ?? ((message) => console.warn(message));
	const getuid = options.getuid ?? (() => {
		try {
			return typeof process.getuid === "function" ? process.getuid() : void 0;
		} catch {
			return;
		}
	});
	const tmpdir = options.tmpdir ?? os.tmpdir;
	const uid = getuid();
	const isSecureDirForUser = (st) => {
		if (uid === void 0) return true;
		if (typeof st.uid === "number" && st.uid !== uid) return false;
		if (typeof st.mode === "number" && (st.mode & 18) !== 0) return false;
		return true;
	};
	const fallback = () => {
		const base = tmpdir();
		const suffix = uid === void 0 ? "openclaw" : `openclaw-${uid}`;
		return path.join(base, suffix);
	};
	const isTrustedTmpDir = (st) => {
		return st.isDirectory() && !st.isSymbolicLink() && isSecureDirForUser(st);
	};
	const resolveDirState = (candidatePath) => {
		try {
			if (!isTrustedTmpDir(lstatSync(candidatePath))) return "invalid";
			accessSync(candidatePath, TMP_DIR_ACCESS_MODE);
			return "available";
		} catch (err) {
			if (isNodeErrorWithCode(err, "ENOENT")) return "missing";
			return "invalid";
		}
	};
	const tryRepairWritableBits = (candidatePath) => {
		try {
			const st = lstatSync(candidatePath);
			if (!st.isDirectory() || st.isSymbolicLink()) return false;
			if (uid !== void 0 && typeof st.uid === "number" && st.uid !== uid) return false;
			if (typeof st.mode !== "number" || (st.mode & 18) === 0) return false;
			chmodSync(candidatePath, 448);
			warn(`[openclaw] tightened permissions on temp dir: ${candidatePath}`);
			return resolveDirState(candidatePath) === "available";
		} catch {
			return false;
		}
	};
	const ensureTrustedFallbackDir = () => {
		const fallbackPath = fallback();
		const state = resolveDirState(fallbackPath);
		if (state === "available") return fallbackPath;
		if (state === "invalid") {
			if (tryRepairWritableBits(fallbackPath)) return fallbackPath;
			throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
		}
		try {
			mkdirSync(fallbackPath, {
				recursive: true,
				mode: 448
			});
			chmodSync(fallbackPath, 448);
		} catch {
			throw new Error(`Unable to create fallback OpenClaw temp dir: ${fallbackPath}`);
		}
		if (resolveDirState(fallbackPath) !== "available" && !tryRepairWritableBits(fallbackPath)) throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
		return fallbackPath;
	};
	const existingPreferredState = resolveDirState(POSIX_OPENCLAW_TMP_DIR);
	if (existingPreferredState === "available") return POSIX_OPENCLAW_TMP_DIR;
	if (existingPreferredState === "invalid") {
		if (tryRepairWritableBits("/tmp/openclaw")) return POSIX_OPENCLAW_TMP_DIR;
		return ensureTrustedFallbackDir();
	}
	try {
		accessSync("/tmp", TMP_DIR_ACCESS_MODE);
		mkdirSync(POSIX_OPENCLAW_TMP_DIR, {
			recursive: true,
			mode: 448
		});
		chmodSync(POSIX_OPENCLAW_TMP_DIR, 448);
		if (resolveDirState("/tmp/openclaw") !== "available" && !tryRepairWritableBits("/tmp/openclaw")) return ensureTrustedFallbackDir();
		return POSIX_OPENCLAW_TMP_DIR;
	} catch {
		return ensureTrustedFallbackDir();
	}
}
//#endregion
//#region src/logging/node-require.ts
function resolveNodeRequireFromMeta(metaUrl) {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return null;
	try {
		const moduleNamespace = getBuiltinModule("module");
		const createRequire = typeof moduleNamespace.createRequire === "function" ? moduleNamespace.createRequire : null;
		return createRequire ? createRequire(metaUrl) : null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/logging/logger.ts
const DEFAULT_LOG_DIR = resolvePreferredOpenClawTmpDir();
path.join(DEFAULT_LOG_DIR, "openclaw.log");
resolveNodeRequireFromMeta(import.meta.url);
//#endregion
//#region src/terminal/palette.ts
const LOBSTER_PALETTE = {
	accent: "#FF5A2D",
	accentBright: "#FF7A3D",
	accentDim: "#D14A22",
	info: "#FF8A5B",
	success: "#2FBF71",
	warn: "#FFB020",
	error: "#E23D2D",
	muted: "#8B7F77"
};
//#endregion
//#region src/terminal/theme.ts
const hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;
const hex = (value) => baseChalk.hex(value);
const theme = {
	accent: hex(LOBSTER_PALETTE.accent),
	accentBright: hex(LOBSTER_PALETTE.accentBright),
	accentDim: hex(LOBSTER_PALETTE.accentDim),
	info: hex(LOBSTER_PALETTE.info),
	success: hex(LOBSTER_PALETTE.success),
	warn: hex(LOBSTER_PALETTE.warn),
	error: hex(LOBSTER_PALETTE.error),
	muted: hex(LOBSTER_PALETTE.muted),
	heading: baseChalk.bold.hex(LOBSTER_PALETTE.accent),
	command: hex(LOBSTER_PALETTE.accentBright),
	option: hex(LOBSTER_PALETTE.warn)
};
theme.success;
theme.warn;
theme.info;
theme.error;
//#endregion
//#region src/infra/openclaw-exec-env.ts
const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
function markOpenClawExecEnv(env) {
	return {
		...env,
		[OPENCLAW_CLI_ENV_VAR]: "1"
	};
}
//#endregion
//#region src/terminal/progress-line.ts
let activeStream = null;
function clearActiveProgressLine() {
	if (!activeStream?.isTTY) return;
	activeStream.write("\r\x1B[2K");
}
//#endregion
//#region src/runtime.ts
function shouldEmitRuntimeLog(env = process.env) {
	if (env.VITEST !== "true") return true;
	if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") return true;
	return typeof console.log.mock === "object";
}
function createRuntimeIo() {
	return {
		log: (...args) => {
			if (!shouldEmitRuntimeLog()) return;
			clearActiveProgressLine();
			console.log(...args);
		},
		error: (...args) => {
			clearActiveProgressLine();
			console.error(...args);
		}
	};
}
({ ...createRuntimeIo() });
//#endregion
//#region src/terminal/ansi.ts
const ANSI_SGR_PATTERN = "\\x1b\\[[0-9;]*m";
const OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";
new RegExp(ANSI_SGR_PATTERN, "g");
new RegExp(OSC8_PATTERN, "g");
typeof Intl !== "undefined" && "Segmenter" in Intl && new Intl.Segmenter(void 0, { granularity: "grapheme" });
resolveNodeRequireFromMeta(import.meta.url);
(() => {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return null;
	try {
		const utilNamespace = getBuiltinModule("util");
		return typeof utilNamespace.inspect === "function" ? utilNamespace.inspect : null;
	} catch {
		return null;
	}
})();
//#endregion
//#region src/process/spawn-utils.ts
function resolveCommandStdio(params) {
	return [
		params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe",
		"pipe",
		"pipe"
	];
}
//#endregion
//#region src/process/windows-command.ts
function resolveWindowsCommandShim(params) {
	if ((params.platform ?? process$1.platform) !== "win32") return params.command;
	const basename = path.basename(params.command).toLowerCase();
	if (path.extname(basename)) return params.command;
	if (params.cmdCommands.includes(basename)) return `${params.command}.cmd`;
	return params.command;
}
promisify(execFile);
const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;
function isWindowsBatchCommand(resolvedCommand) {
	if (process$1.platform !== "win32") return false;
	const ext = path.extname(resolvedCommand).toLowerCase();
	return ext === ".cmd" || ext === ".bat";
}
function escapeForCmdExe(arg) {
	if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) throw new Error(`Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. Pass an explicit shell-wrapper argv at the call site instead.`);
	if (!arg.includes(" ") && !arg.includes("\"")) return arg;
	return `"${arg.replace(/"/g, "\"\"")}"`;
}
function buildCmdExeCommandLine(resolvedCommand, args) {
	return [escapeForCmdExe(resolvedCommand), ...args.map(escapeForCmdExe)].join(" ");
}
/**
* On Windows, Node 18.20.2+ (CVE-2024-27980) rejects spawning .cmd/.bat directly
* without shell, causing EINVAL. Resolve npm/npx to node + cli script so we
* spawn node.exe instead of npm.cmd.
*/
function resolveNpmArgvForWindows(argv) {
	if (process$1.platform !== "win32" || argv.length === 0) return null;
	const basename = path.basename(argv[0]).toLowerCase().replace(/\.(cmd|exe|bat)$/, "");
	const cliName = basename === "npx" ? "npx-cli.js" : basename === "npm" ? "npm-cli.js" : null;
	if (!cliName) return null;
	const nodeDir = path.dirname(process$1.execPath);
	const cliPath = path.join(nodeDir, "node_modules", "npm", "bin", cliName);
	if (!fs.existsSync(cliPath)) {
		const command = argv[0] ?? "";
		return [path.extname(command).toLowerCase() ? command : `${command}.cmd`, ...argv.slice(1)];
	}
	return [
		process$1.execPath,
		cliPath,
		...argv.slice(1)
	];
}
/**
* Resolves a command for Windows compatibility.
* On Windows, non-.exe commands (like pnpm, yarn) are resolved to .cmd; npm/npx
* are handled by resolveNpmArgvForWindows to avoid spawn EINVAL (no direct .cmd).
*/
function resolveCommand(command) {
	return resolveWindowsCommandShim({
		command,
		cmdCommands: ["pnpm", "yarn"]
	});
}
function shouldSpawnWithShell(params) {
	return false;
}
function resolveCommandEnv(params) {
	const baseEnv = params.baseEnv ?? process$1.env;
	const argv = params.argv;
	const shouldSuppressNpmFund = (() => {
		const cmd = path.basename(argv[0] ?? "");
		if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") return true;
		if (cmd === "node" || cmd === "node.exe") return (argv[1] ?? "").includes("npm-cli.js");
		return false;
	})();
	const mergedEnv = params.env ? {
		...baseEnv,
		...params.env
	} : { ...baseEnv };
	const resolvedEnv = Object.fromEntries(Object.entries(mergedEnv).filter(([, value]) => value !== void 0).map(([key, value]) => [key, String(value)]));
	if (shouldSuppressNpmFund) {
		if (resolvedEnv.NPM_CONFIG_FUND == null) resolvedEnv.NPM_CONFIG_FUND = "false";
		if (resolvedEnv.npm_config_fund == null) resolvedEnv.npm_config_fund = "false";
	}
	return markOpenClawExecEnv(resolvedEnv);
}
async function runCommandWithTimeout(argv, optionsOrTimeout) {
	const options = typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
	const { timeoutMs, cwd, input, env, noOutputTimeoutMs } = options;
	const { windowsVerbatimArguments } = options;
	const hasInput = input !== void 0;
	const resolvedEnv = resolveCommandEnv({
		argv,
		env
	});
	const stdio = resolveCommandStdio({
		hasInput,
		preferInherit: true
	});
	const finalArgv = process$1.platform === "win32" ? resolveNpmArgvForWindows(argv) ?? argv : argv;
	const resolvedCommand = finalArgv !== argv ? finalArgv[0] ?? "" : resolveCommand(argv[0] ?? "");
	const useCmdWrapper = isWindowsBatchCommand(resolvedCommand);
	const child = spawn(useCmdWrapper ? process$1.env.ComSpec ?? "cmd.exe" : resolvedCommand, useCmdWrapper ? [
		"/d",
		"/s",
		"/c",
		buildCmdExeCommandLine(resolvedCommand, finalArgv.slice(1))
	] : finalArgv.slice(1), {
		stdio,
		cwd,
		env: resolvedEnv,
		windowsVerbatimArguments: useCmdWrapper ? true : windowsVerbatimArguments,
		...shouldSpawnWithShell({
			resolvedCommand,
			platform: process$1.platform
		}) ? { shell: true } : {}
	});
	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let noOutputTimedOut = false;
		let noOutputTimer = null;
		const shouldTrackOutputTimeout = typeof noOutputTimeoutMs === "number" && Number.isFinite(noOutputTimeoutMs) && noOutputTimeoutMs > 0;
		const clearNoOutputTimer = () => {
			if (!noOutputTimer) return;
			clearTimeout(noOutputTimer);
			noOutputTimer = null;
		};
		const armNoOutputTimer = () => {
			if (!shouldTrackOutputTimeout || settled) return;
			clearNoOutputTimer();
			noOutputTimer = setTimeout(() => {
				if (settled) return;
				noOutputTimedOut = true;
				if (typeof child.kill === "function") child.kill("SIGKILL");
			}, Math.floor(noOutputTimeoutMs));
		};
		const timer = setTimeout(() => {
			timedOut = true;
			if (typeof child.kill === "function") child.kill("SIGKILL");
		}, timeoutMs);
		armNoOutputTimer();
		if (hasInput && child.stdin) {
			child.stdin.write(input ?? "");
			child.stdin.end();
		}
		child.stdout?.on("data", (d) => {
			stdout += d.toString();
			armNoOutputTimer();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
			armNoOutputTimer();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearNoOutputTimer();
			reject(err);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearNoOutputTimer();
			const termination = noOutputTimedOut ? "no-output-timeout" : timedOut ? "timeout" : signal != null ? "signal" : "exit";
			resolve({
				pid: child.pid ?? void 0,
				stdout,
				stderr,
				code,
				signal,
				killed: child.killed,
				termination,
				noOutputTimedOut
			});
		});
	});
}
//#endregion
//#region src/plugin-sdk/run-command.ts
async function runPluginCommandWithTimeout(options) {
	const [command] = options.argv;
	if (!command) return {
		code: 1,
		stdout: "",
		stderr: "command is required"
	};
	try {
		const result = await runCommandWithTimeout(options.argv, {
			timeoutMs: options.timeoutMs,
			cwd: options.cwd,
			env: options.env
		});
		const timedOut = result.termination === "timeout" || result.termination === "no-output-timeout";
		return {
			code: result.code ?? 1,
			stdout: result.stdout,
			stderr: timedOut ? result.stderr || `command timed out after ${options.timeoutMs}ms` : result.stderr
		};
	} catch (error) {
		return {
			code: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error)
		};
	}
}
//#endregion
export { approveDevicePairing, issueDeviceBootstrapToken, listDevicePairing, resolveGatewayBindUrl, resolveTailnetHostWithRunner, runPluginCommandWithTimeout };
