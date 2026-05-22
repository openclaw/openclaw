import { o as resolveRequiredHomeDir, r as resolveHomeRelativePath } from "./home-dir-g5LU3LmA.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
const LEGACY_STATE_DIRNAMES = [".clawdbot"];
const NEW_STATE_DIRNAME = ".openclaw";
const CONFIG_FILENAME = "openclaw.json";
const LEGACY_CONFIG_FILENAMES = ["clawdbot.json"];
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
function resolveLegacyStateDir(homedir = resolveDefaultHomeDir) {
	return legacyStateDirs(homedir)[0] ?? newStateDir(homedir);
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
	const override = env.OPENCLAW_STATE_DIR?.trim();
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
	return resolveHomeRelativePath(input, {
		env,
		homedir
	});
}
/**
* Optional allowlist of directories that `$include` directives may resolve
* outside the config directory. Set via `OPENCLAW_INCLUDE_ROOTS` as a
* platform-delimited path list (`:` on POSIX, `;` on Windows).
*
* Each entry is tilde-expanded and resolved to an absolute path. Entries that
* cannot be resolved or that are not absolute after expansion are dropped.
*
* Returns an empty array when the var is unset or contains no usable entries,
* preserving the historical behavior where `$include` is confined to the
* directory containing `openclaw.json`.
*/
function resolveIncludeRoots(env = process.env, homedir = envHomedir(env)) {
	const raw = env.OPENCLAW_INCLUDE_ROOTS?.trim();
	if (!raw) return [];
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const seen = /* @__PURE__ */ new Set();
	const roots = [];
	for (const entry of raw.split(path.delimiter)) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const resolved = path.resolve(resolveHomeRelativePath(trimmed, {
			env,
			homedir: effectiveHomedir
		}));
		if (!path.isAbsolute(resolved) || seen.has(resolved)) continue;
		seen.add(resolved);
		roots.push(resolved);
	}
	return roots;
}
const STATE_DIR = resolveStateDir();
/**
* Config file path (JSON or JSON5).
* Can be overridden via OPENCLAW_CONFIG_PATH.
* Default: ~/.openclaw/openclaw.json (or $OPENCLAW_STATE_DIR/openclaw.json)
*/
function resolveCanonicalConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env))) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim();
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
/**
* Active config path (prefers existing config files).
*/
function resolveConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env)), homedir = envHomedir(env)) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim();
	if (override) return resolveUserPath(override, env, homedir);
	if (env.OPENCLAW_TEST_FAST === "1") return path.join(stateDir, CONFIG_FILENAME);
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
	const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
	if (explicit) return [resolveUserPath(explicit, env, effectiveHomedir)];
	const candidates = [];
	const openclawStateDir = env.OPENCLAW_STATE_DIR?.trim();
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
	if (override) return resolveUserPath(override, env, envHomedir(env));
	return path.join(stateDir, "credentials");
}
function resolveOAuthPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env))) {
	return path.join(resolveOAuthDir(env, stateDir), OAUTH_FILENAME);
}
function parseGatewayPortEnvValue(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	if (/^\d+$/.test(trimmed)) {
		const parsed = Number.parseInt(trimmed, 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	}
	const bracketedIpv6Match = trimmed.match(/^\[[^\]]+\]:(\d+)$/);
	if (bracketedIpv6Match?.[1]) {
		const parsed = Number.parseInt(bracketedIpv6Match[1], 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	}
	const firstColon = trimmed.indexOf(":");
	const lastColon = trimmed.lastIndexOf(":");
	if (firstColon <= 0 || firstColon !== lastColon) return null;
	const suffix = trimmed.slice(firstColon + 1);
	if (!/^\d+$/.test(suffix)) return null;
	const parsed = Number.parseInt(suffix, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function resolveGatewayPort(cfg, env = process.env) {
	const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim();
	const envPort = parseGatewayPortEnvValue(envRaw);
	if (envPort !== null) return envPort;
	const configPort = cfg?.gateway?.port;
	if (typeof configPort === "number" && Number.isFinite(configPort)) {
		if (configPort > 0) return configPort;
	}
	return DEFAULT_GATEWAY_PORT;
}
//#endregion
export { resolveOAuthPath as _, resolveCanonicalConfigPath as a, resolveDefaultConfigCandidates as c, resolveIncludeRoots as d, resolveIsNixMode as f, resolveOAuthDir as g, resolveNewStateDir as h, isNixMode as i, resolveGatewayLockDir as l, resolveLegacyStateDirs as m, DEFAULT_GATEWAY_PORT as n, resolveConfigPath as o, resolveLegacyStateDir as p, STATE_DIR as r, resolveConfigPathCandidate as s, CONFIG_PATH as t, resolveGatewayPort as u, resolveStateDir as v };
