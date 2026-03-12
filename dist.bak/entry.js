#!/usr/bin/env node
import { spawn } from "node:child_process";
import process$1 from "node:process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import chalk, { Chalk } from "chalk";
import { Logger } from "tslog";
import JSON5 from "json5";
import util from "node:util";

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
//#region src/cli/profile-utils.ts
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function isValidProfileName(value) {
	if (!value) return false;
	return PROFILE_NAME_RE.test(value);
}
function normalizeProfileName(raw) {
	const profile = raw?.trim();
	if (!profile) return null;
	if (profile.toLowerCase() === "default") return null;
	if (!isValidProfileName(profile)) return null;
	return profile;
}

//#endregion
//#region src/cli/profile.ts
function takeValue(raw, next) {
	if (raw.includes("=")) {
		const [, value] = raw.split("=", 2);
		return {
			value: (value ?? "").trim() || null,
			consumedNext: false
		};
	}
	return {
		value: (next ?? "").trim() || null,
		consumedNext: Boolean(next)
	};
}
function parseCliProfileArgs(argv) {
	if (argv.length < 2) return {
		ok: true,
		profile: null,
		argv
	};
	const out = argv.slice(0, 2);
	let profile = null;
	let sawDev = false;
	let sawCommand = false;
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === void 0) continue;
		if (sawCommand) {
			out.push(arg);
			continue;
		}
		if (arg === "--dev") {
			if (profile && profile !== "dev") return {
				ok: false,
				error: "Cannot combine --dev with --profile"
			};
			sawDev = true;
			profile = "dev";
			continue;
		}
		if (arg === "--profile" || arg.startsWith("--profile=")) {
			if (sawDev) return {
				ok: false,
				error: "Cannot combine --dev with --profile"
			};
			const next = args[i + 1];
			const { value, consumedNext } = takeValue(arg, next);
			if (consumedNext) i += 1;
			if (!value) return {
				ok: false,
				error: "--profile requires a value"
			};
			if (!isValidProfileName(value)) return {
				ok: false,
				error: "Invalid --profile (use letters, numbers, \"_\", \"-\" only)"
			};
			profile = value;
			continue;
		}
		if (!arg.startsWith("-")) {
			sawCommand = true;
			out.push(arg);
			continue;
		}
		out.push(arg);
	}
	return {
		ok: true,
		profile,
		argv: out
	};
}
function resolveProfileStateDir(profile, env, homedir) {
	const suffix = profile.toLowerCase() === "default" ? "" : `-${profile}`;
	return path.join(resolveRequiredHomeDir(env, homedir), `.openclaw${suffix}`);
}
function applyCliProfileEnv(params) {
	const env = params.env ?? process.env;
	const homedir = params.homedir ?? os.homedir;
	const profile = params.profile.trim();
	if (!profile) return;
	env.OPENCLAW_PROFILE = profile;
	const stateDir = env.OPENCLAW_STATE_DIR?.trim() || resolveProfileStateDir(profile, env, homedir);
	if (!env.OPENCLAW_STATE_DIR?.trim()) env.OPENCLAW_STATE_DIR = stateDir;
	if (!env.OPENCLAW_CONFIG_PATH?.trim()) env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
	if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) env.OPENCLAW_GATEWAY_PORT = "19001";
}

//#endregion
//#region src/daemon/runtime-binary.ts
const NODE_VERSIONED_PATTERN = /^node(?:-\d+|\d+)(?:\.\d+)*(?:\.exe)?$/;
function normalizeRuntimeBasename(execPath) {
	const trimmed = execPath.trim().replace(/^["']|["']$/g, "");
	const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return (lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1)).toLowerCase();
}
function isNodeRuntime(execPath) {
	const base = normalizeRuntimeBasename(execPath);
	return base === "node" || base === "node.exe" || base === "nodejs" || base === "nodejs.exe" || NODE_VERSIONED_PATTERN.test(base);
}
function isBunRuntime(execPath) {
	const base = normalizeRuntimeBasename(execPath);
	return base === "bun" || base === "bun.exe";
}

//#endregion
//#region src/cli/argv.ts
const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);
const ROOT_VERSION_ALIAS_FLAG = "-v";
const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level"]);
const FLAG_TERMINATOR = "--";
function hasHelpOrVersion(argv) {
	return argv.some((arg) => HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg)) || hasRootVersionAlias(argv);
}
function isValueToken(arg) {
	if (!arg) return false;
	if (arg === FLAG_TERMINATOR) return false;
	if (!arg.startsWith("-")) return true;
	return /^-\d+(?:\.\d+)?$/.test(arg);
}
function parsePositiveInt(value) {
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return;
	return parsed;
}
function hasFlag(argv, name) {
	const args = argv.slice(2);
	for (const arg of args) {
		if (arg === FLAG_TERMINATOR) break;
		if (arg === name) return true;
	}
	return false;
}
function hasRootVersionAlias(argv) {
	const args = argv.slice(2);
	let hasAlias = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === FLAG_TERMINATOR) break;
		if (arg === ROOT_VERSION_ALIAS_FLAG) {
			hasAlias = true;
			continue;
		}
		if (ROOT_BOOLEAN_FLAGS.has(arg)) continue;
		if (arg.startsWith("--profile=")) continue;
		if (ROOT_VALUE_FLAGS.has(arg)) {
			const next = args[i + 1];
			if (isValueToken(next)) i += 1;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return false;
	}
	return hasAlias;
}
function getFlagValue(argv, name) {
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === FLAG_TERMINATOR) break;
		if (arg === name) {
			const next = args[i + 1];
			return isValueToken(next) ? next : null;
		}
		if (arg.startsWith(`${name}=`)) {
			const value = arg.slice(name.length + 1);
			return value ? value : null;
		}
	}
}
function getVerboseFlag(argv, options) {
	if (hasFlag(argv, "--verbose")) return true;
	if (options?.includeDebug && hasFlag(argv, "--debug")) return true;
	return false;
}
function getPositiveIntFlagValue(argv, name) {
	const raw = getFlagValue(argv, name);
	if (raw === null || raw === void 0) return raw;
	return parsePositiveInt(raw);
}
function getCommandPath(argv, depth = 2) {
	const args = argv.slice(2);
	const path = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--") break;
		if (arg.startsWith("-")) continue;
		path.push(arg);
		if (path.length >= depth) break;
	}
	return path;
}
function getPrimaryCommand(argv) {
	const [primary] = getCommandPath(argv, 1);
	return primary ?? null;
}
function buildParseArgv(params) {
	const baseArgv = params.rawArgs && params.rawArgs.length > 0 ? params.rawArgs : params.fallbackArgv && params.fallbackArgv.length > 0 ? params.fallbackArgv : process.argv;
	const programName = params.programName ?? "";
	const normalizedArgv = programName && baseArgv[0] === programName ? baseArgv.slice(1) : baseArgv[0]?.endsWith("openclaw") ? baseArgv.slice(1) : baseArgv;
	if (normalizedArgv.length >= 2 && (isNodeRuntime(normalizedArgv[0] ?? "") || isBunRuntime(normalizedArgv[0] ?? ""))) return normalizedArgv;
	return [
		"node",
		programName || "openclaw",
		...normalizedArgv
	];
}
function shouldMigrateStateFromPath(path) {
	if (path.length === 0) return true;
	const [primary, secondary] = path;
	if (primary === "health" || primary === "status" || primary === "sessions") return false;
	if (primary === "config" && (secondary === "get" || secondary === "unset")) return false;
	if (primary === "models" && (secondary === "list" || secondary === "status")) return false;
	if (primary === "memory" && secondary === "status") return false;
	if (primary === "agent") return false;
	return true;
}

//#endregion
//#region src/cli/respawn-policy.ts
function shouldSkipRespawnForArgv(argv) {
	return hasHelpOrVersion(argv);
}

//#endregion
//#region src/cli/windows-argv.ts
function normalizeWindowsArgv(argv) {
	if (process.platform !== "win32") return argv;
	if (argv.length < 2) return argv;
	const stripControlChars = (value) => {
		let out = "";
		for (let i = 0; i < value.length; i += 1) {
			const code = value.charCodeAt(i);
			if (code >= 32 && code !== 127) out += value[i];
		}
		return out;
	};
	const normalizeArg = (value) => stripControlChars(value).replace(/^['"]+|['"]+$/g, "").trim();
	const normalizeCandidate = (value) => normalizeArg(value).replace(/^\\\\\\?\\/, "");
	const execPath = normalizeCandidate(process.execPath);
	const execPathLower = execPath.toLowerCase();
	const execBase = path.basename(execPath).toLowerCase();
	const isExecPath = (value) => {
		if (!value) return false;
		const normalized = normalizeCandidate(value);
		if (!normalized) return false;
		const lower = normalized.toLowerCase();
		return lower === execPathLower || path.basename(lower) === execBase || lower.endsWith("\\node.exe") || lower.endsWith("/node.exe") || lower.includes("node.exe") || path.basename(lower) === "node.exe" && fs.existsSync(normalized);
	};
	const next = [...argv];
	for (let i = 1; i <= 3 && i < next.length;) {
		if (isExecPath(next[i])) {
			next.splice(i, 1);
			continue;
		}
		i += 1;
	}
	const filtered = next.filter((arg, index) => index === 0 || !isExecPath(arg));
	if (filtered.length < 3) return filtered;
	const cleaned = [...filtered];
	for (let i = 2; i < cleaned.length;) {
		const arg = cleaned[i];
		if (!arg || arg.startsWith("-")) {
			i += 1;
			continue;
		}
		if (isExecPath(arg)) {
			cleaned.splice(i, 1);
			continue;
		}
		break;
	}
	return cleaned;
}

//#endregion
//#region src/hooks/internal-hooks.ts
/** Registry of hook handlers by event key
*
* Uses a process-global singleton to survive bundle splitting.
* When internal-hooks.ts is duplicated across multiple Rollup chunks
* (e.g. reply-*.js and pi-embedded-*.js), each chunk gets its own
* module instance with a separate Map. Using globalThis ensures all
* instances share the same backing store regardless of which chunk
* calls registerInternalHook vs triggerInternalHook.
*/
const GLOBAL_KEY = "__openclaw_internal_hook_handlers__";
if (!globalThis[GLOBAL_KEY]) globalThis[GLOBAL_KEY] = /* @__PURE__ */ new Map();
const handlers = globalThis[GLOBAL_KEY];
const log$1 = createSubsystemLogger("internal-hooks");
/**
* Register a hook handler for a specific event type or event:action combination
*
* @param eventKey - Event type (e.g., 'command') or specific action (e.g., 'command:new')
* @param handler - Function to call when the event is triggered
*
* @example
* ```ts
* // Listen to all command events
* registerInternalHook('command', async (event) => {
*   console.log('Command:', event.action);
* });
*
* // Listen only to /new commands
* registerInternalHook('command:new', async (event) => {
*   await saveSessionToMemory(event);
* });
* ```
*/
function registerInternalHook(eventKey, handler) {
	if (!handlers.has(eventKey)) handlers.set(eventKey, []);
	handlers.get(eventKey).push(handler);
}
/**
* Clear all registered hooks (useful for testing)
*/
function clearInternalHooks() {
	handlers.clear();
}
/**
* Trigger a hook event
*
* Calls all handlers registered for:
* 1. The general event type (e.g., 'command')
* 2. The specific event:action combination (e.g., 'command:new')
*
* Handlers are called in registration order. Errors are caught and logged
* but don't prevent other handlers from running.
*
* @param event - The event to trigger
*/
async function triggerInternalHook(event) {
	const typeHandlers = handlers.get(event.type) ?? [];
	const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
	const allHandlers = [...typeHandlers, ...specificHandlers];
	if (allHandlers.length === 0) return;
	for (const handler of allHandlers) try {
		await handler(event);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log$1.error(`Hook error [${event.type}:${event.action}]: ${message}`);
	}
}
/**
* Create a hook event with common fields filled in
*
* @param type - The event type
* @param action - The action within that type
* @param sessionKey - The session key
* @param context - Additional context
*/
function createInternalHookEvent(type, action, sessionKey, context = {}) {
	return {
		type,
		action,
		sessionKey,
		context,
		timestamp: /* @__PURE__ */ new Date(),
		messages: []
	};
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
const isNixMode = resolveIsNixMode();
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
function resolveLegacyStateDirs(homedir = resolveDefaultHomeDir) {
	return legacyStateDirs(homedir);
}
function resolveNewStateDir(homedir = resolveDefaultHomeDir) {
	return newStateDir(homedir);
}
/**
* State directory for mutable data (sessions, logs, caches).
* Can be overridden via OPENCLAW_STATE_DIR.
* Default: ~/.openclaw
*/
function resolveStateDir(env = process.env, homedir = envHomedir(env)) {
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (override) return resolveUserPath$1(override, env, effectiveHomedir);
	const newDir = newStateDir(effectiveHomedir);
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
function resolveUserPath$1(input, env = process.env, homedir = envHomedir(env)) {
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
const STATE_DIR = resolveStateDir();
/**
* Config file path (JSON5).
* Can be overridden via OPENCLAW_CONFIG_PATH.
* Default: ~/.openclaw/openclaw.json (or $OPENCLAW_STATE_DIR/openclaw.json)
*/
function resolveCanonicalConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env))) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
	if (override) return resolveUserPath$1(override, env, envHomedir(env));
	return path.join(stateDir, CONFIG_FILENAME);
}
/**
* Resolve the active config path by preferring existing config candidates
* before falling back to the canonical path.
*/
function resolveConfigPathCandidate(env = process.env, homedir = envHomedir(env)) {
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
/**
* Active config path (prefers existing config files).
*/
function resolveConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env)), homedir = envHomedir(env)) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim();
	if (override) return resolveUserPath$1(override, env, homedir);
	const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
	const existing = [path.join(stateDir, CONFIG_FILENAME), ...LEGACY_CONFIG_FILENAMES.map((name) => path.join(stateDir, name))].find((candidate) => {
		try {
			return fs.existsSync(candidate);
		} catch {
			return false;
		}
	});
	if (existing) return existing;
	if (stateOverride) return path.join(stateDir, CONFIG_FILENAME);
	const defaultStateDir = resolveStateDir(env, homedir);
	if (path.resolve(stateDir) === path.resolve(defaultStateDir)) return resolveConfigPathCandidate(env, homedir);
	return path.join(stateDir, CONFIG_FILENAME);
}
const CONFIG_PATH = resolveConfigPathCandidate();
/**
* Resolve default config path candidates across default locations.
* Order: explicit config path → state-dir-derived paths → new default.
*/
function resolveDefaultConfigCandidates(env = process.env, homedir = envHomedir(env)) {
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const explicit = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
	if (explicit) return [resolveUserPath$1(explicit, env, effectiveHomedir)];
	const candidates = [];
	const openclawStateDir = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (openclawStateDir) {
		const resolved = resolveUserPath$1(openclawStateDir, env, effectiveHomedir);
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
const DEFAULT_GATEWAY_PORT = 18789;
/**
* Gateway lock directory (ephemeral).
* Default: os.tmpdir()/openclaw-<uid> (uid suffix when available).
*/
function resolveGatewayLockDir(tmpdir = os.tmpdir) {
	const base = tmpdir();
	const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
	const suffix = uid != null ? `openclaw-${uid}` : "openclaw";
	return path.join(base, suffix);
}
const OAUTH_FILENAME = "oauth.json";
/**
* OAuth credentials storage directory.
*
* Precedence:
* - `OPENCLAW_OAUTH_DIR` (explicit override)
* - `$*_STATE_DIR/credentials` (canonical server/default)
*/
function resolveOAuthDir(env = process.env, stateDir = resolveStateDir(env, envHomedir(env))) {
	const override = env.OPENCLAW_OAUTH_DIR?.trim();
	if (override) return resolveUserPath$1(override, env, envHomedir(env));
	return path.join(stateDir, "credentials");
}
function resolveOAuthPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env))) {
	return path.join(resolveOAuthDir(env, stateDir), OAUTH_FILENAME);
}
function resolveGatewayPort(cfg, env = process.env) {
	const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim() || env.CLAWDBOT_GATEWAY_PORT?.trim();
	if (envRaw) {
		const parsed = Number.parseInt(envRaw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	const configPort = cfg?.gateway?.port;
	if (typeof configPort === "number" && Number.isFinite(configPort)) {
		if (configPort > 0) return configPort;
	}
	return DEFAULT_GATEWAY_PORT;
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
		if (tryRepairWritableBits(POSIX_OPENCLAW_TMP_DIR)) return POSIX_OPENCLAW_TMP_DIR;
		return ensureTrustedFallbackDir();
	}
	try {
		accessSync("/tmp", TMP_DIR_ACCESS_MODE);
		mkdirSync(POSIX_OPENCLAW_TMP_DIR, {
			recursive: true,
			mode: 448
		});
		chmodSync(POSIX_OPENCLAW_TMP_DIR, 448);
		if (resolveDirState(POSIX_OPENCLAW_TMP_DIR) !== "available" && !tryRepairWritableBits(POSIX_OPENCLAW_TMP_DIR)) return ensureTrustedFallbackDir();
		return POSIX_OPENCLAW_TMP_DIR;
	} catch {
		return ensureTrustedFallbackDir();
	}
}

//#endregion
//#region src/logging/config.ts
function readLoggingConfig() {
	const configPath = resolveConfigPath();
	try {
		if (!fs.existsSync(configPath)) return;
		const raw = fs.readFileSync(configPath, "utf-8");
		const logging = JSON5.parse(raw)?.logging;
		if (!logging || typeof logging !== "object" || Array.isArray(logging)) return;
		return logging;
	} catch {
		return;
	}
}

//#endregion
//#region src/logging/levels.ts
const ALLOWED_LOG_LEVELS = [
	"silent",
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace"
];
function tryParseLogLevel(level) {
	if (typeof level !== "string") return;
	const candidate = level.trim();
	return ALLOWED_LOG_LEVELS.includes(candidate) ? candidate : void 0;
}
function normalizeLogLevel(level, fallback = "info") {
	return tryParseLogLevel(level) ?? fallback;
}
function levelToMinLevel(level) {
	return {
		fatal: 0,
		error: 1,
		warn: 2,
		info: 3,
		debug: 4,
		trace: 5,
		silent: Number.POSITIVE_INFINITY
	}[level];
}

//#endregion
//#region src/logging/state.ts
const loggingState = {
	cachedLogger: null,
	cachedSettings: null,
	cachedConsoleSettings: null,
	overrideSettings: null,
	invalidEnvLogLevelValue: null,
	consolePatched: false,
	forceConsoleToStderr: false,
	consoleTimestampPrefix: false,
	consoleSubsystemFilter: null,
	resolvingConsoleSettings: false,
	streamErrorHandlersInstalled: false,
	rawConsole: null
};

//#endregion
//#region src/logging/env-log-level.ts
function resolveEnvLogLevelOverride() {
	const raw = process.env.OPENCLAW_LOG_LEVEL;
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (!trimmed) {
		loggingState.invalidEnvLogLevelValue = null;
		return;
	}
	const parsed = tryParseLogLevel(trimmed);
	if (parsed) {
		loggingState.invalidEnvLogLevelValue = null;
		return parsed;
	}
	if (loggingState.invalidEnvLogLevelValue !== trimmed) {
		loggingState.invalidEnvLogLevelValue = trimmed;
		process.stderr.write(`[openclaw] Ignoring invalid OPENCLAW_LOG_LEVEL="${trimmed}" (allowed: ${ALLOWED_LOG_LEVELS.join("|")}).\n`);
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
const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "openclaw.log");
const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 1440 * 60 * 1e3;
const DEFAULT_MAX_LOG_FILE_BYTES = 500 * 1024 * 1024;
const requireConfig$1 = resolveNodeRequireFromMeta(import.meta.url);
const externalTransports = /* @__PURE__ */ new Set();
function attachExternalTransport(logger, transport) {
	logger.attachTransport((logObj) => {
		if (!externalTransports.has(transport)) return;
		try {
			transport(logObj);
		} catch {}
	});
}
function resolveSettings() {
	let cfg = loggingState.overrideSettings ?? readLoggingConfig();
	if (!cfg) try {
		cfg = (requireConfig$1?.("../config/config.js"))?.loadConfig?.().logging;
	} catch {
		cfg = void 0;
	}
	const defaultLevel = process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1" ? "silent" : "info";
	const fromConfig = normalizeLogLevel(cfg?.level, defaultLevel);
	return {
		level: resolveEnvLogLevelOverride() ?? fromConfig,
		file: cfg?.file ?? defaultRollingPathForToday(),
		maxFileBytes: resolveMaxLogFileBytes(cfg?.maxFileBytes)
	};
}
function settingsChanged(a, b) {
	if (!a) return true;
	return a.level !== b.level || a.file !== b.file || a.maxFileBytes !== b.maxFileBytes;
}
function isFileLogLevelEnabled(level) {
	const settings = loggingState.cachedSettings ?? resolveSettings();
	if (!loggingState.cachedSettings) loggingState.cachedSettings = settings;
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
function buildLogger(settings) {
	fs.mkdirSync(path.dirname(settings.file), { recursive: true });
	if (isRollingPath(settings.file)) pruneOldRollingLogs(path.dirname(settings.file));
	let currentFileBytes = getCurrentLogFileBytes(settings.file);
	let warnedAboutSizeCap = false;
	const logger = new Logger({
		name: "openclaw",
		minLevel: levelToMinLevel(settings.level),
		type: "hidden"
	});
	logger.attachTransport((logObj) => {
		try {
			const time = logObj.date?.toISOString?.() ?? (/* @__PURE__ */ new Date()).toISOString();
			const payload = `${JSON.stringify({
				...logObj,
				time
			})}\n`;
			const payloadBytes = Buffer.byteLength(payload, "utf8");
			const nextBytes = currentFileBytes + payloadBytes;
			if (nextBytes > settings.maxFileBytes) {
				if (!warnedAboutSizeCap) {
					warnedAboutSizeCap = true;
					const warningLine = JSON.stringify({
						time: (/* @__PURE__ */ new Date()).toISOString(),
						level: "warn",
						subsystem: "logging",
						message: `log file size cap reached; suppressing writes file=${settings.file} maxFileBytes=${settings.maxFileBytes}`
					});
					appendLogLine(settings.file, `${warningLine}\n`);
					process.stderr.write(`[openclaw] log file size cap reached; suppressing writes file=${settings.file} maxFileBytes=${settings.maxFileBytes}\n`);
				}
				return;
			}
			if (appendLogLine(settings.file, payload)) currentFileBytes = nextBytes;
		} catch {}
	});
	for (const transport of externalTransports) attachExternalTransport(logger, transport);
	return logger;
}
function resolveMaxLogFileBytes(raw) {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return DEFAULT_MAX_LOG_FILE_BYTES;
}
function getCurrentLogFileBytes(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}
function appendLogLine(file, line) {
	try {
		fs.appendFileSync(file, line, { encoding: "utf8" });
		return true;
	} catch {
		return false;
	}
}
function getLogger() {
	const settings = resolveSettings();
	const cachedLogger = loggingState.cachedLogger;
	const cachedSettings = loggingState.cachedSettings;
	if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
		loggingState.cachedLogger = buildLogger(settings);
		loggingState.cachedSettings = settings;
	}
	return loggingState.cachedLogger;
}
function getChildLogger(bindings, opts) {
	const base = getLogger();
	const minLevel = opts?.level ? levelToMinLevel(opts.level) : void 0;
	const name = bindings ? JSON.stringify(bindings) : void 0;
	return base.getSubLogger({
		name,
		minLevel,
		prefix: bindings ? [name ?? ""] : []
	});
}
function toPinoLikeLogger(logger, level) {
	const buildChild = (bindings) => toPinoLikeLogger(logger.getSubLogger({ name: bindings ? JSON.stringify(bindings) : void 0 }), level);
	return {
		level,
		child: buildChild,
		trace: (...args) => logger.trace(...args),
		debug: (...args) => logger.debug(...args),
		info: (...args) => logger.info(...args),
		warn: (...args) => logger.warn(...args),
		error: (...args) => logger.error(...args),
		fatal: (...args) => logger.fatal(...args)
	};
}
function getResolvedLoggerSettings() {
	return resolveSettings();
}
function formatLocalDate(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function defaultRollingPathForToday() {
	const today = formatLocalDate(/* @__PURE__ */ new Date());
	return path.join(DEFAULT_LOG_DIR, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}
function isRollingPath(file) {
	const base = path.basename(file);
	return base.startsWith(`${LOG_PREFIX}-`) && base.endsWith(LOG_SUFFIX) && base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length;
}
function pruneOldRollingLogs(dir) {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const cutoff = Date.now() - MAX_LOG_AGE_MS;
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) continue;
			const fullPath = path.join(dir, entry.name);
			try {
				if (fs.statSync(fullPath).mtimeMs < cutoff) fs.rmSync(fullPath, { force: true });
			} catch {}
		}
	} catch {}
}

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
const isRich = () => Boolean(baseChalk.level > 0);
const colorize = (rich, color, value) => rich ? color(value) : value;

//#endregion
//#region src/globals.ts
let globalVerbose = false;
let globalYes = false;
function setVerbose(v) {
	globalVerbose = v;
}
function isVerbose() {
	return globalVerbose;
}
function shouldLogVerbose() {
	return globalVerbose || isFileLogLevelEnabled("debug");
}
function logVerbose(message) {
	if (!shouldLogVerbose()) return;
	try {
		getLogger().debug({ message }, "verbose");
	} catch {}
	if (!globalVerbose) return;
	console.log(theme.muted(message));
}
function logVerboseConsole(message) {
	if (!globalVerbose) return;
	console.log(theme.muted(message));
}
function isYes() {
	return globalYes;
}
const success = theme.success;
const warn = theme.warn;
const info = theme.info;
const danger = theme.error;

//#endregion
//#region src/infra/plain-object.ts
/**
* Strict plain-object guard (excludes arrays and host objects).
*/
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}

//#endregion
//#region src/utils.ts
async function ensureDir(dir) {
	await fs.promises.mkdir(dir, { recursive: true });
}
/**
* Check if a file or directory exists at the given path.
*/
async function pathExists(targetPath) {
	try {
		await fs.promises.access(targetPath);
		return true;
	} catch {
		return false;
	}
}
function clampNumber(value, min, max) {
	return Math.max(min, Math.min(max, value));
}
function clampInt(value, min, max) {
	return clampNumber(Math.floor(value), min, max);
}
/** Alias for clampNumber (shorter, more common name) */
const clamp = clampNumber;
/**
* Escapes special regex characters in a string so it can be used in a RegExp constructor.
*/
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
* Safely parse JSON, returning null on error instead of throwing.
*/
function safeParseJson(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
/**
* Type guard for Record<string, unknown> (less strict than isPlainObject).
* Accepts any non-null object that isn't an array.
*/
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeE164(number) {
	const digits = number.replace(/^whatsapp:/, "").trim().replace(/[^\d+]/g, "");
	if (digits.startsWith("+")) return `+${digits.slice(1)}`;
	return `+${digits}`;
}
/**
* "Self-chat mode" heuristic (single phone): the gateway is logged in as the owner's own WhatsApp account,
* and `channels.whatsapp.allowFrom` includes that same number. Used to avoid side-effects that make no sense when the
* "bot" and the human are the same WhatsApp identity (e.g. auto read receipts, @mention JID triggers).
*/
function isSelfChatMode(selfE164, allowFrom) {
	if (!selfE164) return false;
	if (!Array.isArray(allowFrom) || allowFrom.length === 0) return false;
	const normalizedSelf = normalizeE164(selfE164);
	return allowFrom.some((n) => {
		if (n === "*") return false;
		try {
			return normalizeE164(String(n)) === normalizedSelf;
		} catch {
			return false;
		}
	});
}
function toWhatsappJid(number) {
	const withoutPrefix = number.replace(/^whatsapp:/, "").trim();
	if (withoutPrefix.includes("@")) return withoutPrefix;
	return `${normalizeE164(withoutPrefix).replace(/\D/g, "")}@s.whatsapp.net`;
}
function resolveLidMappingDirs(opts) {
	const dirs = /* @__PURE__ */ new Set();
	const addDir = (dir) => {
		if (!dir) return;
		dirs.add(resolveUserPath(dir));
	};
	addDir(opts?.authDir);
	for (const dir of opts?.lidMappingDirs ?? []) addDir(dir);
	addDir(resolveOAuthDir());
	addDir(path.join(CONFIG_DIR, "credentials"));
	return [...dirs];
}
function readLidReverseMapping(lid, opts) {
	const mappingFilename = `lid-mapping-${lid}_reverse.json`;
	const mappingDirs = resolveLidMappingDirs(opts);
	for (const dir of mappingDirs) {
		const mappingPath = path.join(dir, mappingFilename);
		try {
			const data = fs.readFileSync(mappingPath, "utf8");
			const phone = JSON.parse(data);
			if (phone === null || phone === void 0) continue;
			return normalizeE164(String(phone));
		} catch {}
	}
	return null;
}
function jidToE164(jid, opts) {
	const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/);
	if (match) return `+${match[1]}`;
	const lidMatch = jid.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/);
	if (lidMatch) {
		const lid = lidMatch[1];
		const phone = readLidReverseMapping(lid, opts);
		if (phone) return phone;
		if (opts?.logMissing ?? shouldLogVerbose()) logVerbose(`LID mapping not found for ${lid}; skipping inbound message`);
	}
	return null;
}
async function resolveJidToE164(jid, opts) {
	if (!jid) return null;
	const direct = jidToE164(jid, opts);
	if (direct) return direct;
	if (!/(@lid|@hosted\.lid)$/.test(jid)) return null;
	if (!opts?.lidLookup?.getPNForLID) return null;
	try {
		const pnJid = await opts.lidLookup.getPNForLID(jid);
		if (!pnJid) return null;
		return jidToE164(pnJid, opts);
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`LID mapping lookup failed for ${jid}: ${String(err)}`);
		return null;
	}
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function isHighSurrogate(codeUnit) {
	return codeUnit >= 55296 && codeUnit <= 56319;
}
function isLowSurrogate(codeUnit) {
	return codeUnit >= 56320 && codeUnit <= 57343;
}
function sliceUtf16Safe(input, start, end) {
	const len = input.length;
	let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
	let to = end === void 0 ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
	if (to < from) {
		const tmp = from;
		from = to;
		to = tmp;
	}
	if (from > 0 && from < len) {
		if (isLowSurrogate(input.charCodeAt(from)) && isHighSurrogate(input.charCodeAt(from - 1))) from += 1;
	}
	if (to > 0 && to < len) {
		if (isHighSurrogate(input.charCodeAt(to - 1)) && isLowSurrogate(input.charCodeAt(to))) to -= 1;
	}
	return input.slice(from, to);
}
function truncateUtf16Safe(input, maxLen) {
	const limit = Math.max(0, Math.floor(maxLen));
	if (input.length <= limit) return input;
	return sliceUtf16Safe(input, 0, limit);
}
function resolveUserPath(input) {
	if (!input) return "";
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		const expanded = expandHomePrefix(trimmed, {
			home: resolveRequiredHomeDir(process.env, os.homedir),
			env: process.env,
			homedir: os.homedir
		});
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}
function resolveConfigDir(env = process.env, homedir = os.homedir) {
	const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (override) return resolveUserPath(override);
	const newDir = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
	try {
		if (fs.existsSync(newDir)) return newDir;
	} catch {}
	return newDir;
}
function resolveHomeDir() {
	return resolveEffectiveHomeDir(process.env, os.homedir);
}
function resolveHomeDisplayPrefix() {
	const home = resolveHomeDir();
	if (!home) return;
	if (process.env.OPENCLAW_HOME?.trim()) return {
		home,
		prefix: "$OPENCLAW_HOME"
	};
	return {
		home,
		prefix: "~"
	};
}
function shortenHomePath(input) {
	if (!input) return input;
	const display = resolveHomeDisplayPrefix();
	if (!display) return input;
	const { home, prefix } = display;
	if (input === home) return prefix;
	if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`)) return `${prefix}${input.slice(home.length)}`;
	return input;
}
function shortenHomeInString(input) {
	if (!input) return input;
	const display = resolveHomeDisplayPrefix();
	if (!display) return input;
	return input.split(display.home).join(display.prefix);
}
function displayPath(input) {
	return shortenHomePath(input);
}
function displayString(input) {
	return shortenHomeInString(input);
}
function formatTerminalLink(label, url, opts) {
	const esc = "\x1B";
	const safeLabel = label.replaceAll(esc, "");
	const safeUrl = url.replaceAll(esc, "");
	if (!(opts?.force === true ? true : opts?.force === false ? false : Boolean(process.stdout.isTTY))) return opts?.fallback ?? `${safeLabel} (${safeUrl})`;
	return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}
const CONFIG_DIR = resolveConfigDir();

//#endregion
//#region src/plugins/commands.ts
const pluginCommands = /* @__PURE__ */ new Map();
let registryLocked = false;
const MAX_ARGS_LENGTH = 4096;
/**
* Reserved command names that plugins cannot override.
* These are built-in commands from commands-registry.data.ts.
*/
const RESERVED_COMMANDS = new Set([
	"help",
	"commands",
	"status",
	"whoami",
	"context",
	"stop",
	"restart",
	"reset",
	"new",
	"compact",
	"config",
	"debug",
	"allowlist",
	"activation",
	"skill",
	"subagents",
	"kill",
	"steer",
	"tell",
	"model",
	"models",
	"queue",
	"send",
	"bash",
	"exec",
	"think",
	"verbose",
	"reasoning",
	"elevated",
	"usage"
]);
/**
* Validate a command name.
* Returns an error message if invalid, or null if valid.
*/
function validateCommandName(name) {
	const trimmed = name.trim().toLowerCase();
	if (!trimmed) return "Command name cannot be empty";
	if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
	if (RESERVED_COMMANDS.has(trimmed)) return `Command name "${trimmed}" is reserved by a built-in command`;
	return null;
}
/**
* Register a plugin command.
* Returns an error if the command name is invalid or reserved.
*/
function registerPluginCommand(pluginId, command) {
	if (registryLocked) return {
		ok: false,
		error: "Cannot register commands while processing is in progress"
	};
	if (typeof command.handler !== "function") return {
		ok: false,
		error: "Command handler must be a function"
	};
	const validationError = validateCommandName(command.name);
	if (validationError) return {
		ok: false,
		error: validationError
	};
	const key = `/${command.name.toLowerCase()}`;
	if (pluginCommands.has(key)) {
		const existing = pluginCommands.get(key);
		return {
			ok: false,
			error: `Command "${command.name}" already registered by plugin "${existing.pluginId}"`
		};
	}
	pluginCommands.set(key, {
		...command,
		pluginId
	});
	logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
	return { ok: true };
}
/**
* Clear all registered plugin commands.
* Called during plugin reload.
*/
function clearPluginCommands() {
	pluginCommands.clear();
}
/**
* Check if a command body matches a registered plugin command.
* Returns the command definition and parsed args if matched.
*
* Note: If a command has `acceptsArgs: false` and the user provides arguments,
* the command will not match. This allows the message to fall through to
* built-in handlers or the agent. Document this behavior to plugin authors.
*/
function matchPluginCommand(commandBody) {
	const trimmed = commandBody.trim();
	if (!trimmed.startsWith("/")) return null;
	const spaceIndex = trimmed.indexOf(" ");
	const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const args = spaceIndex === -1 ? void 0 : trimmed.slice(spaceIndex + 1).trim();
	const key = commandName.toLowerCase();
	const command = pluginCommands.get(key);
	if (!command) return null;
	if (args && !command.acceptsArgs) return null;
	return {
		command,
		args: args || void 0
	};
}
/**
* Sanitize command arguments to prevent injection attacks.
* Removes control characters and enforces length limits.
*/
function sanitizeArgs(args) {
	if (!args) return;
	if (args.length > MAX_ARGS_LENGTH) return args.slice(0, MAX_ARGS_LENGTH);
	let sanitized = "";
	for (const char of args) {
		const code = char.charCodeAt(0);
		if (!(code <= 31 && code !== 9 && code !== 10 || code === 127)) sanitized += char;
	}
	return sanitized;
}
/**
* Execute a plugin command handler.
*
* Note: Plugin authors should still validate and sanitize ctx.args for their
* specific use case. This function provides basic defense-in-depth sanitization.
*/
async function executePluginCommand(params) {
	const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } = params;
	if (command.requireAuth !== false && !isAuthorizedSender) {
		logVerbose(`Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`);
		return { text: "⚠️ This command requires authorization." };
	}
	const sanitizedArgs = sanitizeArgs(args);
	const ctx = {
		senderId,
		channel,
		channelId: params.channelId,
		isAuthorizedSender,
		args: sanitizedArgs,
		commandBody,
		config,
		from: params.from,
		to: params.to,
		accountId: params.accountId,
		messageThreadId: params.messageThreadId
	};
	registryLocked = true;
	try {
		const result = await command.handler(ctx);
		logVerbose(`Plugin command /${command.name} executed successfully for ${senderId || "unknown"}`);
		return result;
	} catch (err) {
		const error = err;
		logVerbose(`Plugin command /${command.name} error: ${error.message}`);
		return { text: "⚠️ Command failed. Please try again later." };
	} finally {
		registryLocked = false;
	}
}
/**
* List all registered plugin commands.
* Used for /help and /commands output.
*/
function listPluginCommands() {
	return Array.from(pluginCommands.values()).map((cmd) => ({
		name: cmd.name,
		description: cmd.description,
		pluginId: cmd.pluginId
	}));
}
/**
* Get plugin command specs for native command registration (e.g., Telegram).
*/
function getPluginCommandSpecs() {
	return Array.from(pluginCommands.values()).map((cmd) => ({
		name: cmd.name,
		description: cmd.description
	}));
}

//#endregion
//#region src/plugins/http-path.ts
function normalizePluginHttpPath(path, fallback) {
	const trimmed = path?.trim();
	if (!trimmed) {
		const fallbackTrimmed = fallback?.trim();
		if (!fallbackTrimmed) return null;
		return fallbackTrimmed.startsWith("/") ? fallbackTrimmed : `/${fallbackTrimmed}`;
	}
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

//#endregion
//#region src/plugins/registry.ts
function createEmptyPluginRegistry() {
	return {
		plugins: [],
		tools: [],
		hooks: [],
		typedHooks: [],
		channels: [],
		providers: [],
		gatewayHandlers: {},
		httpHandlers: [],
		httpRoutes: [],
		cliRegistrars: [],
		services: [],
		commands: [],
		diagnostics: []
	};
}
function createPluginRegistry(registryParams) {
	const registry = createEmptyPluginRegistry();
	const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));
	const pushDiagnostic = (diag) => {
		registry.diagnostics.push(diag);
	};
	const registerTool = (record, tool, opts) => {
		const names = opts?.names ?? (opts?.name ? [opts.name] : []);
		const optional = opts?.optional === true;
		const factory = typeof tool === "function" ? tool : (_ctx) => tool;
		if (typeof tool !== "function") names.push(tool.name);
		const normalized = names.map((name) => name.trim()).filter(Boolean);
		if (normalized.length > 0) record.toolNames.push(...normalized);
		registry.tools.push({
			pluginId: record.id,
			factory,
			names: normalized,
			optional,
			source: record.source
		});
	};
	const registerHook = (record, events, handler, opts, config) => {
		const normalizedEvents = (Array.isArray(events) ? events : [events]).map((event) => event.trim()).filter(Boolean);
		const entry = opts?.entry ?? null;
		const name = entry?.hook.name ?? opts?.name?.trim();
		if (!name) {
			pushDiagnostic({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: "hook registration missing name"
			});
			return;
		}
		const description = entry?.hook.description ?? opts?.description ?? "";
		const hookEntry = entry ? {
			...entry,
			hook: {
				...entry.hook,
				name,
				description,
				source: "openclaw-plugin",
				pluginId: record.id
			},
			metadata: {
				...entry.metadata,
				events: normalizedEvents
			}
		} : {
			hook: {
				name,
				description,
				source: "openclaw-plugin",
				pluginId: record.id,
				filePath: record.source,
				baseDir: path.dirname(record.source),
				handlerPath: record.source
			},
			frontmatter: {},
			metadata: { events: normalizedEvents },
			invocation: { enabled: true }
		};
		record.hookNames.push(name);
		registry.hooks.push({
			pluginId: record.id,
			entry: hookEntry,
			events: normalizedEvents,
			source: record.source
		});
		if (!(config?.hooks?.internal?.enabled === true) || opts?.register === false) return;
		for (const event of normalizedEvents) registerInternalHook(event, handler);
	};
	const registerGatewayMethod = (record, method, handler) => {
		const trimmed = method.trim();
		if (!trimmed) return;
		if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `gateway method already registered: ${trimmed}`
			});
			return;
		}
		registry.gatewayHandlers[trimmed] = handler;
		record.gatewayMethods.push(trimmed);
	};
	const registerHttpHandler = (record, handler) => {
		record.httpHandlers += 1;
		registry.httpHandlers.push({
			pluginId: record.id,
			handler,
			source: record.source
		});
	};
	const registerHttpRoute = (record, params) => {
		const normalizedPath = normalizePluginHttpPath(params.path);
		if (!normalizedPath) {
			pushDiagnostic({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: "http route registration missing path"
			});
			return;
		}
		if (registry.httpRoutes.some((entry) => entry.path === normalizedPath)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `http route already registered: ${normalizedPath}`
			});
			return;
		}
		record.httpHandlers += 1;
		registry.httpRoutes.push({
			pluginId: record.id,
			path: normalizedPath,
			handler: params.handler,
			source: record.source
		});
	};
	const registerChannel = (record, registration) => {
		const normalized = typeof registration.plugin === "object" ? registration : { plugin: registration };
		const plugin = normalized.plugin;
		const id = typeof plugin?.id === "string" ? plugin.id.trim() : String(plugin?.id ?? "").trim();
		if (!id) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "channel registration missing id"
			});
			return;
		}
		record.channelIds.push(id);
		registry.channels.push({
			pluginId: record.id,
			plugin,
			dock: normalized.dock,
			source: record.source
		});
	};
	const registerProvider = (record, provider) => {
		const id = typeof provider?.id === "string" ? provider.id.trim() : "";
		if (!id) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "provider registration missing id"
			});
			return;
		}
		const existing = registry.providers.find((entry) => entry.provider.id === id);
		if (existing) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `provider already registered: ${id} (${existing.pluginId})`
			});
			return;
		}
		record.providerIds.push(id);
		registry.providers.push({
			pluginId: record.id,
			provider,
			source: record.source
		});
	};
	const registerCli = (record, registrar, opts) => {
		const commands = (opts?.commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
		record.cliCommands.push(...commands);
		registry.cliRegistrars.push({
			pluginId: record.id,
			register: registrar,
			commands,
			source: record.source
		});
	};
	const registerService = (record, service) => {
		const id = service.id.trim();
		if (!id) return;
		record.services.push(id);
		registry.services.push({
			pluginId: record.id,
			service,
			source: record.source
		});
	};
	const registerCommand = (record, command) => {
		const name = command.name.trim();
		if (!name) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "command registration missing name"
			});
			return;
		}
		const result = registerPluginCommand(record.id, command);
		if (!result.ok) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `command registration failed: ${result.error}`
			});
			return;
		}
		record.commands.push(name);
		registry.commands.push({
			pluginId: record.id,
			command,
			source: record.source
		});
	};
	const registerTypedHook = (record, hookName, handler, opts) => {
		record.hookCount += 1;
		registry.typedHooks.push({
			pluginId: record.id,
			hookName,
			handler,
			priority: opts?.priority,
			source: record.source
		});
	};
	const normalizeLogger = (logger) => ({
		info: logger.info,
		warn: logger.warn,
		error: logger.error,
		debug: logger.debug
	});
	const createApi = (record, params) => {
		return {
			id: record.id,
			name: record.name,
			version: record.version,
			description: record.description,
			source: record.source,
			config: params.config,
			pluginConfig: params.pluginConfig,
			runtime: registryParams.runtime,
			logger: normalizeLogger(registryParams.logger),
			registerTool: (tool, opts) => registerTool(record, tool, opts),
			registerHook: (events, handler, opts) => registerHook(record, events, handler, opts, params.config),
			registerHttpHandler: (handler) => registerHttpHandler(record, handler),
			registerHttpRoute: (params) => registerHttpRoute(record, params),
			registerChannel: (registration) => registerChannel(record, registration),
			registerProvider: (provider) => registerProvider(record, provider),
			registerGatewayMethod: (method, handler) => registerGatewayMethod(record, method, handler),
			registerCli: (registrar, opts) => registerCli(record, registrar, opts),
			registerService: (service) => registerService(record, service),
			registerCommand: (command) => registerCommand(record, command),
			resolvePath: (input) => resolveUserPath(input),
			on: (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts)
		};
	};
	return {
		registry,
		createApi,
		pushDiagnostic,
		registerTool,
		registerChannel,
		registerProvider,
		registerGatewayMethod,
		registerCli,
		registerService,
		registerCommand,
		registerHook,
		registerTypedHook
	};
}

//#endregion
//#region src/plugins/runtime.ts
const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
const state = (() => {
	const globalState = globalThis;
	if (!globalState[REGISTRY_STATE]) globalState[REGISTRY_STATE] = {
		registry: createEmptyPluginRegistry(),
		key: null
	};
	return globalState[REGISTRY_STATE];
})();
function setActivePluginRegistry(registry, cacheKey) {
	state.registry = registry;
	state.key = cacheKey ?? null;
}
function getActivePluginRegistry() {
	return state.registry;
}
function requireActivePluginRegistry() {
	if (!state.registry) state.registry = createEmptyPluginRegistry();
	return state.registry;
}
function getActivePluginRegistryKey() {
	return state.key;
}

//#endregion
//#region src/channels/registry.ts
const CHAT_CHANNEL_ORDER = [
	"telegram",
	"whatsapp",
	"discord",
	"irc",
	"googlechat",
	"slack",
	"signal",
	"imessage"
];
const CHANNEL_IDS = [...CHAT_CHANNEL_ORDER];
const CHAT_CHANNEL_META = {
	telegram: {
		id: "telegram",
		label: "Telegram",
		selectionLabel: "Telegram (Bot API)",
		detailLabel: "Telegram Bot",
		docsPath: "/channels/telegram",
		docsLabel: "telegram",
		blurb: "simplest way to get started — register a bot with @BotFather and get going.",
		systemImage: "paperplane",
		selectionDocsPrefix: "",
		selectionDocsOmitLabel: true,
		selectionExtras: ["https://openclaw.ai"]
	},
	whatsapp: {
		id: "whatsapp",
		label: "WhatsApp",
		selectionLabel: "WhatsApp (QR link)",
		detailLabel: "WhatsApp Web",
		docsPath: "/channels/whatsapp",
		docsLabel: "whatsapp",
		blurb: "works with your own number; recommend a separate phone + eSIM.",
		systemImage: "message"
	},
	discord: {
		id: "discord",
		label: "Discord",
		selectionLabel: "Discord (Bot API)",
		detailLabel: "Discord Bot",
		docsPath: "/channels/discord",
		docsLabel: "discord",
		blurb: "very well supported right now.",
		systemImage: "bubble.left.and.bubble.right"
	},
	irc: {
		id: "irc",
		label: "IRC",
		selectionLabel: "IRC (Server + Nick)",
		detailLabel: "IRC",
		docsPath: "/channels/irc",
		docsLabel: "irc",
		blurb: "classic IRC networks with DM/channel routing and pairing controls.",
		systemImage: "network"
	},
	googlechat: {
		id: "googlechat",
		label: "Google Chat",
		selectionLabel: "Google Chat (Chat API)",
		detailLabel: "Google Chat",
		docsPath: "/channels/googlechat",
		docsLabel: "googlechat",
		blurb: "Google Workspace Chat app with HTTP webhook.",
		systemImage: "message.badge"
	},
	slack: {
		id: "slack",
		label: "Slack",
		selectionLabel: "Slack (Socket Mode)",
		detailLabel: "Slack Bot",
		docsPath: "/channels/slack",
		docsLabel: "slack",
		blurb: "supported (Socket Mode).",
		systemImage: "number"
	},
	signal: {
		id: "signal",
		label: "Signal",
		selectionLabel: "Signal (signal-cli)",
		detailLabel: "Signal REST",
		docsPath: "/channels/signal",
		docsLabel: "signal",
		blurb: "signal-cli linked device; more setup (David Reagans: \"Hop on Discord.\").",
		systemImage: "antenna.radiowaves.left.and.right"
	},
	imessage: {
		id: "imessage",
		label: "iMessage",
		selectionLabel: "iMessage (imsg)",
		detailLabel: "iMessage",
		docsPath: "/channels/imessage",
		docsLabel: "imessage",
		blurb: "this is still a work in progress.",
		systemImage: "message.fill"
	}
};
const CHAT_CHANNEL_ALIASES = {
	imsg: "imessage",
	"internet-relay-chat": "irc",
	"google-chat": "googlechat",
	gchat: "googlechat"
};
const normalizeChannelKey = (raw) => {
	return raw?.trim().toLowerCase() || void 0;
};
function listChatChannels() {
	return CHAT_CHANNEL_ORDER.map((id) => CHAT_CHANNEL_META[id]);
}
function getChatChannelMeta(id) {
	return CHAT_CHANNEL_META[id];
}
function normalizeChatChannelId(raw) {
	const normalized = normalizeChannelKey(raw);
	if (!normalized) return null;
	const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
	return CHAT_CHANNEL_ORDER.includes(resolved) ? resolved : null;
}
function normalizeChannelId(raw) {
	return normalizeChatChannelId(raw);
}
function normalizeAnyChannelId(raw) {
	const key = normalizeChannelKey(raw);
	if (!key) return null;
	return requireActivePluginRegistry().channels.find((entry) => {
		const id = String(entry.plugin.id ?? "").trim().toLowerCase();
		if (id && id === key) return true;
		return (entry.plugin.meta.aliases ?? []).some((alias) => alias.trim().toLowerCase() === key);
	})?.plugin.id ?? null;
}
function formatChannelPrimerLine(meta) {
	return `${meta.label}: ${meta.blurb}`;
}
function formatChannelSelectionLine(meta, docsLink) {
	const docsPrefix = meta.selectionDocsPrefix ?? "Docs:";
	const docsLabel = meta.docsLabel ?? meta.id;
	const docs = meta.selectionDocsOmitLabel ? docsLink(meta.docsPath) : docsLink(meta.docsPath, docsLabel);
	const extras = (meta.selectionExtras ?? []).filter(Boolean).join(" ");
	return `${meta.label} — ${meta.blurb} ${docsPrefix ? `${docsPrefix} ` : ""}${docs}${extras ? ` ${extras}` : ""}`;
}

//#endregion
//#region src/terminal/progress-line.ts
let activeStream = null;
function registerActiveProgressLine(stream) {
	if (!stream.isTTY) return;
	activeStream = stream;
}
function clearActiveProgressLine() {
	if (!activeStream?.isTTY) return;
	activeStream.write("\r\x1B[2K");
}
function unregisterActiveProgressLine(stream) {
	if (!activeStream) return;
	if (stream && activeStream !== stream) return;
	activeStream = null;
}

//#endregion
//#region src/terminal/restore.ts
const RESET_SEQUENCE = "\x1B[0m\x1B[?25h\x1B[?1000l\x1B[?1002l\x1B[?1003l\x1B[?1006l\x1B[?2004l";
function reportRestoreFailure(scope, err, reason) {
	const suffix = reason ? ` (${reason})` : "";
	const message = `[terminal] restore ${scope} failed${suffix}: ${String(err)}`;
	try {
		process.stderr.write(`${message}\n`);
	} catch (writeErr) {
		console.error(`[terminal] restore reporting failed${suffix}: ${String(writeErr)}`);
	}
}
function restoreTerminalState(reason, options = {}) {
	const resumeStdin = options.resumeStdinIfPaused ?? options.resumeStdin ?? false;
	try {
		clearActiveProgressLine();
	} catch (err) {
		reportRestoreFailure("progress line", err, reason);
	}
	const stdin = process.stdin;
	if (stdin.isTTY && typeof stdin.setRawMode === "function") {
		try {
			stdin.setRawMode(false);
		} catch (err) {
			reportRestoreFailure("raw mode", err, reason);
		}
		if (resumeStdin && typeof stdin.isPaused === "function" && stdin.isPaused()) try {
			stdin.resume();
		} catch (err) {
			reportRestoreFailure("stdin resume", err, reason);
		}
	}
	if (process.stdout.isTTY) try {
		process.stdout.write(RESET_SEQUENCE);
	} catch (err) {
		reportRestoreFailure("stdout reset", err, reason);
	}
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
const defaultRuntime = {
	...createRuntimeIo(),
	exit: (code) => {
		restoreTerminalState("runtime exit", { resumeStdinIfPaused: false });
		process.exit(code);
		throw new Error("unreachable");
	}
};
function createNonExitingRuntime() {
	return {
		...createRuntimeIo(),
		exit: (code) => {
			throw new Error(`exit ${code}`);
		}
	};
}

//#endregion
//#region src/terminal/ansi.ts
const ANSI_SGR_PATTERN = "\\x1b\\[[0-9;]*m";
const OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";
const ANSI_REGEX = new RegExp(ANSI_SGR_PATTERN, "g");
const OSC8_REGEX = new RegExp(OSC8_PATTERN, "g");
function stripAnsi(input) {
	return input.replace(OSC8_REGEX, "").replace(ANSI_REGEX, "");
}
function visibleWidth(input) {
	return Array.from(stripAnsi(input)).length;
}

//#endregion
//#region src/logging/timestamps.ts
function formatLocalIsoWithOffset(now) {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const h = String(now.getHours()).padStart(2, "0");
	const m = String(now.getMinutes()).padStart(2, "0");
	const s = String(now.getSeconds()).padStart(2, "0");
	const ms = String(now.getMilliseconds()).padStart(3, "0");
	const tzOffset = now.getTimezoneOffset();
	return `${year}-${month}-${day}T${h}:${m}:${s}.${ms}${tzOffset <= 0 ? "+" : "-"}${String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0")}:${String(Math.abs(tzOffset) % 60).padStart(2, "0")}`;
}

//#endregion
//#region src/logging/console.ts
const requireConfig = resolveNodeRequireFromMeta(import.meta.url);
const loadConfigFallbackDefault = () => {
	try {
		return (requireConfig?.("../config/config.js"))?.loadConfig?.().logging;
	} catch {
		return;
	}
};
let loadConfigFallback = loadConfigFallbackDefault;
function normalizeConsoleLevel(level) {
	if (isVerbose()) return "debug";
	if (!level && process.env.VITEST === "true" && process.env.OPENCLAW_TEST_CONSOLE !== "1") return "silent";
	return normalizeLogLevel(level, "info");
}
function normalizeConsoleStyle(style) {
	if (style === "compact" || style === "json" || style === "pretty") return style;
	if (!process.stdout.isTTY) return "compact";
	return "pretty";
}
function resolveConsoleSettings() {
	let cfg = loggingState.overrideSettings ?? readLoggingConfig();
	if (!cfg) if (loggingState.resolvingConsoleSettings) cfg = void 0;
	else {
		loggingState.resolvingConsoleSettings = true;
		try {
			cfg = loadConfigFallback();
		} finally {
			loggingState.resolvingConsoleSettings = false;
		}
	}
	return {
		level: resolveEnvLogLevelOverride() ?? normalizeConsoleLevel(cfg?.consoleLevel),
		style: normalizeConsoleStyle(cfg?.consoleStyle)
	};
}
function consoleSettingsChanged(a, b) {
	if (!a) return true;
	return a.level !== b.level || a.style !== b.style;
}
function getConsoleSettings() {
	const settings = resolveConsoleSettings();
	const cached = loggingState.cachedConsoleSettings;
	if (!cached || consoleSettingsChanged(cached, settings)) loggingState.cachedConsoleSettings = settings;
	return loggingState.cachedConsoleSettings;
}
function routeLogsToStderr() {
	loggingState.forceConsoleToStderr = true;
}
function setConsoleSubsystemFilter(filters) {
	if (!filters || filters.length === 0) {
		loggingState.consoleSubsystemFilter = null;
		return;
	}
	const normalized = filters.map((value) => value.trim()).filter((value) => value.length > 0);
	loggingState.consoleSubsystemFilter = normalized.length > 0 ? normalized : null;
}
function setConsoleTimestampPrefix(enabled) {
	loggingState.consoleTimestampPrefix = enabled;
}
function shouldLogSubsystemToConsole(subsystem) {
	const filter = loggingState.consoleSubsystemFilter;
	if (!filter || filter.length === 0) return true;
	return filter.some((prefix) => subsystem === prefix || subsystem.startsWith(`${prefix}/`));
}
const SUPPRESSED_CONSOLE_PREFIXES = [
	"Closing session:",
	"Opening session:",
	"Removing old closed session:",
	"Session already closed",
	"Session already open"
];
function shouldSuppressConsoleMessage(message) {
	if (isVerbose()) return false;
	if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix))) return true;
	if (message.startsWith("[EventQueue] Slow listener detected") && message.includes("DiscordMessageListener")) return true;
	return false;
}
function isEpipeError(err) {
	const code = err?.code;
	return code === "EPIPE" || code === "EIO";
}
function formatConsoleTimestamp(style) {
	const now = /* @__PURE__ */ new Date();
	if (style === "pretty") return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
	return formatLocalIsoWithOffset(now);
}
function hasTimestampPrefix(value) {
	return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.test(value);
}
function isJsonPayload(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}
/**
* Route console.* calls through file logging while still emitting to stdout/stderr.
* This keeps user-facing output unchanged but guarantees every console call is captured in log files.
*/
function enableConsoleCapture() {
	if (loggingState.consolePatched) return;
	loggingState.consolePatched = true;
	if (!loggingState.streamErrorHandlersInstalled) {
		loggingState.streamErrorHandlersInstalled = true;
		for (const stream of [process.stdout, process.stderr]) stream.on("error", (err) => {
			if (isEpipeError(err)) return;
			throw err;
		});
	}
	let logger = null;
	const getLoggerLazy = () => {
		if (!logger) logger = getLogger();
		return logger;
	};
	const original = {
		log: console.log,
		info: console.info,
		warn: console.warn,
		error: console.error,
		debug: console.debug,
		trace: console.trace
	};
	loggingState.rawConsole = {
		log: original.log,
		info: original.info,
		warn: original.warn,
		error: original.error
	};
	const forward = (level, orig) => (...args) => {
		const formatted = util.format(...args);
		if (shouldSuppressConsoleMessage(formatted)) return;
		const trimmed = stripAnsi(formatted).trimStart();
		const timestamp = loggingState.consoleTimestampPrefix && trimmed.length > 0 && !hasTimestampPrefix(trimmed) && !isJsonPayload(trimmed) ? formatConsoleTimestamp(getConsoleSettings().style) : "";
		try {
			const resolvedLogger = getLoggerLazy();
			if (level === "trace") resolvedLogger.trace(formatted);
			else if (level === "debug") resolvedLogger.debug(formatted);
			else if (level === "info") resolvedLogger.info(formatted);
			else if (level === "warn") resolvedLogger.warn(formatted);
			else if (level === "error" || level === "fatal") resolvedLogger.error(formatted);
			else resolvedLogger.info(formatted);
		} catch {}
		if (loggingState.forceConsoleToStderr) try {
			const line = timestamp ? `${timestamp} ${formatted}` : formatted;
			process.stderr.write(`${line}\n`);
		} catch (err) {
			if (isEpipeError(err)) return;
			throw err;
		}
		else try {
			if (!timestamp) {
				orig.apply(console, args);
				return;
			}
			if (args.length === 0) {
				orig.call(console, timestamp);
				return;
			}
			if (typeof args[0] === "string") {
				orig.call(console, `${timestamp} ${args[0]}`, ...args.slice(1));
				return;
			}
			orig.call(console, timestamp, ...args);
		} catch (err) {
			if (isEpipeError(err)) return;
			throw err;
		}
	};
	console.log = forward("info", original.log);
	console.info = forward("info", original.info);
	console.warn = forward("warn", original.warn);
	console.error = forward("error", original.error);
	console.debug = forward("debug", original.debug);
	console.trace = forward("trace", original.trace);
}

//#endregion
//#region src/logging/subsystem.ts
function shouldLogToConsole(level, settings) {
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
const inspectValue = (() => {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return null;
	try {
		const utilNamespace = getBuiltinModule("util");
		return typeof utilNamespace.inspect === "function" ? utilNamespace.inspect : null;
	} catch {
		return null;
	}
})();
function formatRuntimeArg(arg) {
	if (typeof arg === "string") return arg;
	if (inspectValue) return inspectValue(arg);
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}
function isRichConsoleEnv() {
	const term = (process.env.TERM ?? "").toLowerCase();
	if (process.env.COLORTERM || process.env.TERM_PROGRAM) return true;
	return term.length > 0 && term !== "dumb";
}
function getColorForConsole() {
	const hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
	if (process.env.NO_COLOR && !hasForceColor) return new Chalk({ level: 0 });
	return Boolean(process.stdout.isTTY || process.stderr.isTTY) || isRichConsoleEnv() ? new Chalk({ level: 1 }) : new Chalk({ level: 0 });
}
const SUBSYSTEM_COLORS = [
	"cyan",
	"green",
	"yellow",
	"blue",
	"magenta",
	"red"
];
const SUBSYSTEM_COLOR_OVERRIDES = { "gmail-watcher": "blue" };
const SUBSYSTEM_PREFIXES_TO_DROP = [
	"gateway",
	"channels",
	"providers"
];
const SUBSYSTEM_MAX_SEGMENTS = 2;
const CHANNEL_SUBSYSTEM_PREFIXES = new Set(CHAT_CHANNEL_ORDER);
function pickSubsystemColor(color, subsystem) {
	const override = SUBSYSTEM_COLOR_OVERRIDES[subsystem];
	if (override) return color[override];
	let hash = 0;
	for (let i = 0; i < subsystem.length; i += 1) hash = hash * 31 + subsystem.charCodeAt(i) | 0;
	return color[SUBSYSTEM_COLORS[Math.abs(hash) % SUBSYSTEM_COLORS.length]];
}
function formatSubsystemForConsole(subsystem) {
	const parts = subsystem.split("/").filter(Boolean);
	const original = parts.join("/") || subsystem;
	while (parts.length > 0 && SUBSYSTEM_PREFIXES_TO_DROP.includes(parts[0])) parts.shift();
	if (parts.length === 0) return original;
	if (CHANNEL_SUBSYSTEM_PREFIXES.has(parts[0])) return parts[0];
	if (parts.length > SUBSYSTEM_MAX_SEGMENTS) return parts.slice(-SUBSYSTEM_MAX_SEGMENTS).join("/");
	return parts.join("/");
}
function stripRedundantSubsystemPrefixForConsole(message, displaySubsystem) {
	if (!displaySubsystem) return message;
	if (message.startsWith("[")) {
		const closeIdx = message.indexOf("]");
		if (closeIdx > 1) {
			if (message.slice(1, closeIdx).toLowerCase() === displaySubsystem.toLowerCase()) {
				let i = closeIdx + 1;
				while (message[i] === " ") i += 1;
				return message.slice(i);
			}
		}
	}
	if (message.slice(0, displaySubsystem.length).toLowerCase() !== displaySubsystem.toLowerCase()) return message;
	const next = message.slice(displaySubsystem.length, displaySubsystem.length + 1);
	if (next !== ":" && next !== " ") return message;
	let i = displaySubsystem.length;
	while (message[i] === " ") i += 1;
	if (message[i] === ":") i += 1;
	while (message[i] === " ") i += 1;
	return message.slice(i);
}
function formatConsoleLine(opts) {
	const displaySubsystem = opts.style === "json" ? opts.subsystem : formatSubsystemForConsole(opts.subsystem);
	if (opts.style === "json") return JSON.stringify({
		time: (/* @__PURE__ */ new Date()).toISOString(),
		level: opts.level,
		subsystem: displaySubsystem,
		message: opts.message,
		...opts.meta
	});
	const color = getColorForConsole();
	const prefix = `[${displaySubsystem}]`;
	const prefixColor = pickSubsystemColor(color, displaySubsystem);
	const levelColor = opts.level === "error" || opts.level === "fatal" ? color.red : opts.level === "warn" ? color.yellow : opts.level === "debug" || opts.level === "trace" ? color.gray : color.cyan;
	const displayMessage = stripRedundantSubsystemPrefixForConsole(opts.message, displaySubsystem);
	return `${[(() => {
		if (opts.style === "pretty") return color.gray((/* @__PURE__ */ new Date()).toISOString().slice(11, 19));
		if (loggingState.consoleTimestampPrefix) return color.gray((/* @__PURE__ */ new Date()).toISOString());
		return "";
	})(), prefixColor(prefix)].filter(Boolean).join(" ")} ${levelColor(displayMessage)}`;
}
function writeConsoleLine(level, line) {
	clearActiveProgressLine();
	const sanitized = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" ? line.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?").replace(/[\uD800-\uDFFF]/g, "?") : line;
	const sink = loggingState.rawConsole ?? console;
	if (loggingState.forceConsoleToStderr || level === "error" || level === "fatal") (sink.error ?? console.error)(sanitized);
	else if (level === "warn") (sink.warn ?? console.warn)(sanitized);
	else (sink.log ?? console.log)(sanitized);
}
function logToFile(fileLogger, level, message, meta) {
	if (level === "silent") return;
	const method = fileLogger[level];
	if (typeof method !== "function") return;
	if (meta && Object.keys(meta).length > 0) method.call(fileLogger, meta, message);
	else method.call(fileLogger, message);
}
function createSubsystemLogger(subsystem) {
	let fileLogger = null;
	const getFileLogger = () => {
		if (!fileLogger) fileLogger = getChildLogger({ subsystem });
		return fileLogger;
	};
	const emit = (level, message, meta) => {
		const consoleSettings = getConsoleSettings();
		let consoleMessageOverride;
		let fileMeta = meta;
		if (meta && Object.keys(meta).length > 0) {
			const { consoleMessage, ...rest } = meta;
			if (typeof consoleMessage === "string") consoleMessageOverride = consoleMessage;
			fileMeta = Object.keys(rest).length > 0 ? rest : void 0;
		}
		logToFile(getFileLogger(), level, message, fileMeta);
		if (!shouldLogToConsole(level, { level: consoleSettings.level })) return;
		if (!shouldLogSubsystemToConsole(subsystem)) return;
		const consoleMessage = consoleMessageOverride ?? message;
		if (!isVerbose() && subsystem === "agent/embedded" && /(sessionId|runId)=probe-/.test(consoleMessage)) return;
		writeConsoleLine(level, formatConsoleLine({
			level,
			subsystem,
			message: consoleSettings.style === "json" ? message : consoleMessage,
			style: consoleSettings.style,
			meta: fileMeta
		}));
	};
	const isConsoleEnabled = (level) => {
		return shouldLogToConsole(level, { level: getConsoleSettings().level }) && shouldLogSubsystemToConsole(subsystem);
	};
	const isFileEnabled = (level) => isFileLogLevelEnabled(level);
	return {
		subsystem,
		isEnabled: (level, target = "any") => {
			if (target === "console") return isConsoleEnabled(level);
			if (target === "file") return isFileEnabled(level);
			return isConsoleEnabled(level) || isFileEnabled(level);
		},
		trace: (message, meta) => emit("trace", message, meta),
		debug: (message, meta) => emit("debug", message, meta),
		info: (message, meta) => emit("info", message, meta),
		warn: (message, meta) => emit("warn", message, meta),
		error: (message, meta) => emit("error", message, meta),
		fatal: (message, meta) => emit("fatal", message, meta),
		raw: (message) => {
			logToFile(getFileLogger(), "info", message, { raw: true });
			if (shouldLogSubsystemToConsole(subsystem)) {
				if (!isVerbose() && subsystem === "agent/embedded" && /(sessionId|runId)=probe-/.test(message)) return;
				writeConsoleLine("info", message);
			}
		},
		child: (name) => createSubsystemLogger(`${subsystem}/${name}`)
	};
}
function runtimeForLogger(logger, exit = defaultRuntime.exit) {
	const formatArgs = (...args) => args.map((arg) => formatRuntimeArg(arg)).join(" ").trim();
	return {
		log: (...args) => logger.info(formatArgs(...args)),
		error: (...args) => logger.error(formatArgs(...args)),
		exit
	};
}

//#endregion
//#region src/utils/boolean.ts
const DEFAULT_TRUTHY = [
	"true",
	"1",
	"yes",
	"on"
];
const DEFAULT_FALSY = [
	"false",
	"0",
	"no",
	"off"
];
const DEFAULT_TRUTHY_SET = new Set(DEFAULT_TRUTHY);
const DEFAULT_FALSY_SET = new Set(DEFAULT_FALSY);
function parseBooleanValue(value, options = {}) {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return;
	const truthy = options.truthy ?? DEFAULT_TRUTHY;
	const falsy = options.falsy ?? DEFAULT_FALSY;
	const truthySet = truthy === DEFAULT_TRUTHY ? DEFAULT_TRUTHY_SET : new Set(truthy);
	const falsySet = falsy === DEFAULT_FALSY ? DEFAULT_FALSY_SET : new Set(falsy);
	if (truthySet.has(normalized)) return true;
	if (falsySet.has(normalized)) return false;
}

//#endregion
//#region src/infra/env.ts
const log = createSubsystemLogger("env");
const loggedEnv = /* @__PURE__ */ new Set();
function formatEnvValue(value, redact) {
	if (redact) return "<redacted>";
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= 160) return singleLine;
	return `${singleLine.slice(0, 160)}…`;
}
function logAcceptedEnvOption(option) {
	if (process.env.VITEST || false) return;
	if (loggedEnv.has(option.key)) return;
	const rawValue = option.value ?? process.env[option.key];
	if (!rawValue || !rawValue.trim()) return;
	loggedEnv.add(option.key);
	log.info(`env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`);
}
function normalizeZaiEnv() {
	if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
}
function isTruthyEnvValue(value) {
	return parseBooleanValue(value) === true;
}
function normalizeEnv() {
	normalizeZaiEnv();
}

//#endregion
//#region src/infra/is-main.ts
function normalizePathCandidate(candidate, cwd) {
	if (!candidate) return;
	const resolved = path.resolve(cwd, candidate);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}
function isMainModule({ currentFile, argv = process.argv, env = process.env, cwd = process.cwd(), wrapperEntryPairs = [] }) {
	const normalizedCurrent = normalizePathCandidate(currentFile, cwd);
	const normalizedArgv1 = normalizePathCandidate(argv[1], cwd);
	if (normalizedCurrent && normalizedArgv1 && normalizedCurrent === normalizedArgv1) return true;
	const normalizedPmExecPath = normalizePathCandidate(env.pm_exec_path, cwd);
	if (normalizedCurrent && normalizedPmExecPath && normalizedCurrent === normalizedPmExecPath) return true;
	if (normalizedCurrent && normalizedArgv1 && wrapperEntryPairs.length > 0) {
		const currentBase = path.basename(normalizedCurrent);
		const argvBase = path.basename(normalizedArgv1);
		if (wrapperEntryPairs.some(({ wrapperBasename, entryBasename }) => currentBase === entryBasename && argvBase === wrapperBasename)) return true;
	}
	if (normalizedCurrent && normalizedArgv1 && path.basename(normalizedCurrent) === path.basename(normalizedArgv1)) return true;
	return false;
}

//#endregion
//#region src/infra/warning-filter.ts
const warningFilterKey = Symbol.for("openclaw.warning-filter");
function shouldIgnoreWarning(warning) {
	if (warning.code === "DEP0040" && warning.message?.includes("punycode")) return true;
	if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) return true;
	if (warning.name === "ExperimentalWarning" && warning.message?.includes("SQLite is an experimental feature")) return true;
	return false;
}
function normalizeWarningArgs(args) {
	const warningArg = args[0];
	const secondArg = args[1];
	const thirdArg = args[2];
	let name;
	let code;
	let message;
	if (warningArg instanceof Error) {
		name = warningArg.name;
		message = warningArg.message;
		code = warningArg.code;
	} else if (typeof warningArg === "string") message = warningArg;
	if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
		const options = secondArg;
		if (typeof options.type === "string") name = options.type;
		if (typeof options.code === "string") code = options.code;
	} else {
		if (typeof secondArg === "string") name = secondArg;
		if (typeof thirdArg === "string") code = thirdArg;
	}
	return {
		name,
		code,
		message
	};
}
function installProcessWarningFilter() {
	const globalState = globalThis;
	if (globalState[warningFilterKey]?.installed) return;
	const originalEmitWarning = process.emitWarning.bind(process);
	const wrappedEmitWarning = ((...args) => {
		if (shouldIgnoreWarning(normalizeWarningArgs(args))) return;
		return Reflect.apply(originalEmitWarning, process, args);
	});
	process.emitWarning = wrappedEmitWarning;
	globalState[warningFilterKey] = { installed: true };
}

//#endregion
//#region src/process/child-process-bridge.ts
const defaultSignals = process$1.platform === "win32" ? [
	"SIGTERM",
	"SIGINT",
	"SIGBREAK"
] : [
	"SIGTERM",
	"SIGINT",
	"SIGHUP",
	"SIGQUIT"
];
function attachChildProcessBridge(child, { signals = defaultSignals, onSignal } = {}) {
	const listeners = /* @__PURE__ */ new Map();
	for (const signal of signals) {
		const listener = () => {
			onSignal?.(signal);
			try {
				child.kill(signal);
			} catch {}
		};
		try {
			process$1.on(signal, listener);
			listeners.set(signal, listener);
		} catch {}
	}
	const detach = () => {
		for (const [signal, listener] of listeners) process$1.off(signal, listener);
		listeners.clear();
	};
	child.once("exit", detach);
	child.once("error", detach);
	return { detach };
}

//#endregion
//#region src/entry.ts
const ENTRY_WRAPPER_PAIRS = [{
	wrapperBasename: "openclaw.mjs",
	entryBasename: "entry.js"
}, {
	wrapperBasename: "openclaw.js",
	entryBasename: "entry.js"
}];
function shouldForceReadOnlyAuthStore(argv) {
	const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
	for (let index = 0; index < tokens.length - 1; index += 1) if (tokens[index] === "secrets" && tokens[index + 1] === "audit") return true;
	return false;
}
if (!isMainModule({
	currentFile: fileURLToPath(import.meta.url),
	wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS]
})) {} else {
	process$1.title = "openclaw";
	installProcessWarningFilter();
	normalizeEnv();
	if (shouldForceReadOnlyAuthStore(process$1.argv)) process$1.env.OPENCLAW_AUTH_STORE_READONLY = "1";
	if (process$1.argv.includes("--no-color")) {
		process$1.env.NO_COLOR = "1";
		process$1.env.FORCE_COLOR = "0";
	}
	const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
	function hasExperimentalWarningSuppressed() {
		const nodeOptions = process$1.env.NODE_OPTIONS ?? "";
		if (nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || nodeOptions.includes("--no-warnings")) return true;
		for (const arg of process$1.execArgv) if (arg === EXPERIMENTAL_WARNING_FLAG || arg === "--no-warnings") return true;
		return false;
	}
	function ensureExperimentalWarningSuppressed() {
		if (shouldSkipRespawnForArgv(process$1.argv)) return false;
		if (isTruthyEnvValue(process$1.env.OPENCLAW_NO_RESPAWN)) return false;
		if (isTruthyEnvValue(process$1.env.OPENCLAW_NODE_OPTIONS_READY)) return false;
		if (hasExperimentalWarningSuppressed()) return false;
		process$1.env.OPENCLAW_NODE_OPTIONS_READY = "1";
		const child = spawn(process$1.execPath, [
			EXPERIMENTAL_WARNING_FLAG,
			...process$1.execArgv,
			...process$1.argv.slice(1)
		], {
			stdio: "inherit",
			env: process$1.env
		});
		attachChildProcessBridge(child);
		child.once("exit", (code, signal) => {
			if (signal) {
				process$1.exitCode = 1;
				return;
			}
			process$1.exit(code ?? 1);
		});
		child.once("error", (error) => {
			console.error("[openclaw] Failed to respawn CLI:", error instanceof Error ? error.stack ?? error.message : error);
			process$1.exit(1);
		});
		return true;
	}
	process$1.argv = normalizeWindowsArgv(process$1.argv);
	if (!ensureExperimentalWarningSuppressed()) {
		const parsed = parseCliProfileArgs(process$1.argv);
		if (!parsed.ok) {
			console.error(`[openclaw] ${parsed.error}`);
			process$1.exit(2);
		}
		if (parsed.profile) {
			applyCliProfileEnv({ profile: parsed.profile });
			process$1.argv = parsed.argv;
		}
		import("./run-main-DV00j_-G.js").then(({ runCli }) => runCli(process$1.argv)).catch((error) => {
			console.error("[openclaw] Failed to start CLI:", error instanceof Error ? error.stack ?? error.message : error);
			process$1.exitCode = 1;
		});
	}
}

//#endregion
export { isRecord as $, resolveStateDir as $t, normalizeChannelId as A, getLogger as At, executePluginCommand as B, STATE_DIR as Bt, CHANNEL_IDS as C, shouldLogVerbose as Ct, getChatChannelMeta as D, isRich as Dt, formatChannelSelectionLine as E, colorize as Et, setActivePluginRegistry as F, normalizeLogLevel as Ft, clamp as G, resolveDefaultConfigCandidates as Gt, listPluginCommands as H, resolveCanonicalConfigPath as Ht, createEmptyPluginRegistry as I, tryParseLogLevel as It, displayPath as J, resolveIsNixMode as Jt, clampInt as K, resolveGatewayLockDir as Kt, createPluginRegistry as L, resolvePreferredOpenClawTmpDir as Lt, getActivePluginRegistry as M, toPinoLikeLogger as Mt, getActivePluginRegistryKey as N, resolveNodeRequireFromMeta as Nt, listChatChannels as O, theme as Ot, requireActivePluginRegistry as P, ALLOWED_LOG_LEVELS as Pt, formatTerminalLink as Q, resolveOAuthPath as Qt, normalizePluginHttpPath as R, CONFIG_PATH as Rt, unregisterActiveProgressLine as S, setVerbose as St, formatChannelPrimerLine as T, warn as Tt, matchPluginCommand as U, resolveConfigPath as Ut, getPluginCommandSpecs as V, isNixMode as Vt, CONFIG_DIR as W, resolveConfigPathCandidate as Wt, ensureDir as X, resolveNewStateDir as Xt, displayString as Y, resolveLegacyStateDirs as Yt, escapeRegExp as Z, resolveOAuthDir as Zt, createNonExitingRuntime as _, normalizeProfileName as _n, info as _t, normalizeEnv as a, buildParseArgv as an, resolveHomeDir as at, clearActiveProgressLine as b, logVerbose as bt, runtimeForLogger as c, getPositiveIntFlagValue as cn, safeParseJson as ct, setConsoleSubsystemFilter as d, hasFlag as dn, sleep as dt, clearInternalHooks as en, isSelfChatMode as et, setConsoleTimestampPrefix as f, hasHelpOrVersion as fn, sliceUtf16Safe as ft, visibleWidth as g, isNodeRuntime as gn, danger as gt, stripAnsi as h, isBunRuntime as hn, isPlainObject as ht, logAcceptedEnvOption as i, normalizeWindowsArgv as in, resolveConfigDir as it, normalizeChatChannelId as j, getResolvedLoggerSettings as jt, normalizeAnyChannelId as k, getChildLogger as kt, enableConsoleCapture as l, getPrimaryCommand as ln, shortenHomeInString as lt, formatLocalIsoWithOffset as m, shouldMigrateStateFromPath as mn, truncateUtf16Safe as mt, isMainModule as n, registerInternalHook as nn, normalizeE164 as nt, parseBooleanValue as o, getCommandPath as on, resolveJidToE164 as ot, shouldLogSubsystemToConsole as p, hasRootVersionAlias as pn, toWhatsappJid as pt, clampNumber as q, resolveGatewayPort as qt, isTruthyEnvValue as r, triggerInternalHook as rn, pathExists as rt, createSubsystemLogger as s, getFlagValue as sn, resolveUserPath as st, installProcessWarningFilter as t, createInternalHookEvent as tn, jidToE164 as tt, routeLogsToStderr as u, getVerboseFlag as un, shortenHomePath as ut, defaultRuntime as v, expandHomePrefix as vn, isVerbose as vt, CHAT_CHANNEL_ORDER as w, success as wt, registerActiveProgressLine as x, logVerboseConsole as xt, restoreTerminalState as y, resolveRequiredHomeDir as yn, isYes as yt, clearPluginCommands as z, DEFAULT_GATEWAY_PORT as zt };