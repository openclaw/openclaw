import { s as init_session_key, t as DEFAULT_AGENT_ID } from "./session-key-BSZsryCD.js";
import { l as resolveStateDir, r as init_paths } from "./paths-CbmqEZIn.js";
import { n as init_subsystem, t as createSubsystemLogger } from "./subsystem-CsPxmH8p.js";
import { _ as resolveUserPath, l as init_utils } from "./utils-CMc9mmF8.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region src/agents/auth-profiles/constants.ts
init_subsystem();
const AUTH_PROFILE_FILENAME = "auth-profiles.json";
const LEGACY_AUTH_FILENAME = "auth.json";
const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
const QWEN_CLI_PROFILE_ID = "qwen-portal:qwen-cli";
const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";
const AUTH_STORE_LOCK_OPTIONS = {
	retries: {
		retries: 10,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 1e4,
		randomize: true
	},
	stale: 3e4
};
const EXTERNAL_CLI_SYNC_TTL_MS = 900 * 1e3;
const EXTERNAL_CLI_NEAR_EXPIRY_MS = 600 * 1e3;
const log = createSubsystemLogger("agents/auth-profiles");
//#endregion
//#region src/agents/agent-paths.ts
init_paths();
init_session_key();
init_utils();
function resolveOpenClawAgentDir(env = process.env) {
	const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	if (override) return resolveUserPath(override, env);
	return resolveUserPath(path.join(resolveStateDir(env), "agents", DEFAULT_AGENT_ID, "agent"), env);
}
//#endregion
//#region src/shared/pid-alive.ts
function isValidPid(pid) {
	return Number.isInteger(pid) && pid > 0;
}
/**
* Check if a process is a zombie on Linux by reading /proc/<pid>/status.
* Returns false on non-Linux platforms or if the proc file can't be read.
*/
function isZombieProcess(pid) {
	if (process.platform !== "linux") return false;
	try {
		return fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^State:\s+(\S)/m)?.[1] === "Z";
	} catch {
		return false;
	}
}
function isPidAlive(pid) {
	if (!isValidPid(pid)) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (isZombieProcess(pid)) return false;
	return true;
}
/**
* Read the process start time (field 22 "starttime") from /proc/<pid>/stat.
* Returns the value in clock ticks since system boot, or null on non-Linux
* platforms or if the proc file can't be read.
*
* This is used to detect PID recycling: if two readings for the same PID
* return different starttimes, the PID has been reused by a different process.
*/
function getProcessStartTime(pid) {
	if (process.platform !== "linux") return null;
	if (!isValidPid(pid)) return null;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const commEndIndex = stat.lastIndexOf(")");
		if (commEndIndex < 0) return null;
		const fields = stat.slice(commEndIndex + 1).trimStart().split(/\s+/);
		const starttime = Number(fields[19]);
		return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/shared/process-scoped-map.ts
function resolveProcessScopedMap(key) {
	const proc = process;
	const existing = proc[key];
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	proc[key] = created;
	return created;
}
//#endregion
//#region src/infra/json-file.ts
function loadJsonFile(pathname) {
	try {
		if (!fs.existsSync(pathname)) return;
		const raw = fs.readFileSync(pathname, "utf8");
		return JSON.parse(raw);
	} catch {
		return;
	}
}
function saveJsonFile(pathname, data) {
	const dir = path.dirname(pathname);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	fs.chmodSync(pathname, 384);
}
//#endregion
//#region src/plugin-sdk/file-lock.ts
const HELD_LOCKS = resolveProcessScopedMap(Symbol.for("openclaw.fileLockHeldLocks"));
function computeDelayMs(retries, attempt) {
	const base = Math.min(retries.maxTimeout, Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt));
	const jitter = retries.randomize ? 1 + Math.random() : 1;
	return Math.min(retries.maxTimeout, Math.round(base * jitter));
}
async function readLockPayload(lockPath) {
	try {
		const raw = await fs$1.readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") return null;
		return {
			pid: parsed.pid,
			createdAt: parsed.createdAt
		};
	} catch {
		return null;
	}
}
async function resolveNormalizedFilePath(filePath) {
	const resolved = path.resolve(filePath);
	const dir = path.dirname(resolved);
	await fs$1.mkdir(dir, { recursive: true });
	try {
		const realDir = await fs$1.realpath(dir);
		return path.join(realDir, path.basename(resolved));
	} catch {
		return resolved;
	}
}
async function isStaleLock(lockPath, staleMs) {
	const payload = await readLockPayload(lockPath);
	if (payload?.pid && !isPidAlive(payload.pid)) return true;
	if (payload?.createdAt) {
		const createdAt = Date.parse(payload.createdAt);
		if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) return true;
	}
	try {
		const stat = await fs$1.stat(lockPath);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch {
		return true;
	}
}
async function releaseHeldLock(normalizedFile) {
	const current = HELD_LOCKS.get(normalizedFile);
	if (!current) return;
	current.count -= 1;
	if (current.count > 0) return;
	HELD_LOCKS.delete(normalizedFile);
	await current.handle.close().catch(() => void 0);
	await fs$1.rm(current.lockPath, { force: true }).catch(() => void 0);
}
/** Acquire a re-entrant process-local file lock backed by a `.lock` sidecar file. */
async function acquireFileLock(filePath, options) {
	const normalizedFile = await resolveNormalizedFilePath(filePath);
	const lockPath = `${normalizedFile}.lock`;
	const held = HELD_LOCKS.get(normalizedFile);
	if (held) {
		held.count += 1;
		return {
			lockPath,
			release: () => releaseHeldLock(normalizedFile)
		};
	}
	const attempts = Math.max(1, options.retries.retries + 1);
	for (let attempt = 0; attempt < attempts; attempt += 1) try {
		const handle = await fs$1.open(lockPath, "wx");
		await handle.writeFile(JSON.stringify({
			pid: process.pid,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		}, null, 2), "utf8");
		HELD_LOCKS.set(normalizedFile, {
			count: 1,
			handle,
			lockPath
		});
		return {
			lockPath,
			release: () => releaseHeldLock(normalizedFile)
		};
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		if (await isStaleLock(lockPath, options.stale)) {
			await fs$1.rm(lockPath, { force: true }).catch(() => void 0);
			continue;
		}
		if (attempt >= attempts - 1) break;
		await new Promise((resolve) => setTimeout(resolve, computeDelayMs(options.retries, attempt)));
	}
	throw new Error(`file lock timeout for ${normalizedFile}`);
}
/** Run an async callback while holding a file lock, always releasing the lock afterward. */
async function withFileLock(filePath, options, fn) {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}
//#endregion
//#region src/agents/auth-profiles/paths.ts
init_utils();
function resolveAuthStorePath(agentDir) {
	const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
	return path.join(resolved, AUTH_PROFILE_FILENAME);
}
function resolveLegacyAuthStorePath(agentDir) {
	const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
	return path.join(resolved, LEGACY_AUTH_FILENAME);
}
function resolveAuthStorePathForDisplay(agentDir) {
	const pathname = resolveAuthStorePath(agentDir);
	return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}
function ensureAuthStoreFile(pathname) {
	if (fs.existsSync(pathname)) return;
	saveJsonFile(pathname, {
		version: 1,
		profiles: {}
	});
}
//#endregion
export { MINIMAX_CLI_PROFILE_ID as _, withFileLock as a, resolveProcessScopedMap as c, resolveOpenClawAgentDir as d, AUTH_STORE_LOCK_OPTIONS as f, EXTERNAL_CLI_SYNC_TTL_MS as g, EXTERNAL_CLI_NEAR_EXPIRY_MS as h, resolveLegacyAuthStorePath as i, getProcessStartTime as l, CODEX_CLI_PROFILE_ID as m, resolveAuthStorePath as n, loadJsonFile as o, CLAUDE_CLI_PROFILE_ID as p, resolveAuthStorePathForDisplay as r, saveJsonFile as s, ensureAuthStoreFile as t, isPidAlive as u, QWEN_CLI_PROFILE_ID as v, log as y };
