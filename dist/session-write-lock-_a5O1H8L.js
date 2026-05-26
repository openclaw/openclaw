import "./fs-safe-defaults-B7hUN42l.js";
import { n as createFileLockManager } from "./file-lock-D6zEe-ZP.js";
import { n as isPidAlive, t as getProcessStartTime } from "./pid-alive-C0-jAJSa.js";
import { r as readGatewayProcessArgsSync } from "./gateway-processes-DtC5jd3t.js";
import { t as SessionWriteLockTimeoutError } from "./session-write-lock-error-HvDhYM6H.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/agents/session-write-lock.ts
function isValidLockNumber(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
const CLEANUP_SIGNALS = [
	"SIGINT",
	"SIGTERM",
	"SIGQUIT",
	"SIGABRT"
];
const CLEANUP_STATE_KEY = Symbol.for("openclaw.sessionWriteLockCleanupState");
const WATCHDOG_STATE_KEY = Symbol.for("openclaw.sessionWriteLockWatchdogState");
const DEFAULT_SESSION_WRITE_LOCK_STALE_MS = 1800 * 1e3;
const DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS = 300 * 1e3;
const DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS = 6e4;
const DEFAULT_WATCHDOG_INTERVAL_MS = 6e4;
const DEFAULT_TIMEOUT_GRACE_MS = 120 * 1e3;
const ORPHAN_LOCK_PAYLOAD_GRACE_MS = 5e3;
const MAX_LOCK_HOLD_MS = 2147e6;
const SESSION_LOCKS = createFileLockManager("openclaw.session-write-lock");
let resolveProcessStartTimeForLock = getProcessStartTime;
function isFileLockError(error, code) {
	return error?.code === code;
}
const SESSION_WRITE_LOCK_ENV = {
	acquireTimeoutMs: "OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS",
	staleMs: "OPENCLAW_SESSION_WRITE_LOCK_STALE_MS",
	maxHoldMs: "OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS"
};
function readPositiveMsEnv(env, key, opts = {}) {
	const raw = env[key]?.trim();
	if (!raw) return;
	return parsePositiveMs(Number(raw), opts);
}
function parsePositiveMs(value, opts = {}) {
	if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return;
	if (value === Number.POSITIVE_INFINITY) return opts.allowInfinity ? value : void 0;
	if (!Number.isFinite(value)) return;
	return value;
}
function resolveSessionWriteLockMs(params) {
	const opts = { allowInfinity: params.allowInfinity };
	return readPositiveMsEnv(params.env ?? process.env, SESSION_WRITE_LOCK_ENV[params.key], opts) ?? parsePositiveMs(params.config?.session?.writeLock?.[params.key], opts) ?? params.fallback;
}
function resolveSessionWriteLockAcquireTimeoutMs(config, env) {
	return resolveSessionWriteLockMs({
		config,
		env,
		key: "acquireTimeoutMs",
		fallback: DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS,
		allowInfinity: true
	});
}
function resolveSessionWriteLockStaleMs(config, env) {
	return resolveSessionWriteLockMs({
		config,
		env,
		key: "staleMs",
		fallback: DEFAULT_SESSION_WRITE_LOCK_STALE_MS
	});
}
function resolveSessionWriteLockMaxHoldMs(config, params = {}) {
	return resolveSessionWriteLockMs({
		config,
		env: params.env,
		key: "maxHoldMs",
		fallback: params.fallback ?? 3e5
	});
}
function resolveSessionWriteLockOptions(config, params = {}) {
	return {
		timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(config, params.env),
		staleMs: resolveSessionWriteLockStaleMs(config, params.env),
		maxHoldMs: resolveSessionWriteLockMaxHoldMs(config, {
			env: params.env,
			fallback: params.maxHoldMsFallback
		})
	};
}
function resolveCleanupState() {
	const proc = process;
	if (!proc[CLEANUP_STATE_KEY]) proc[CLEANUP_STATE_KEY] = {
		registered: false,
		exitHandler: void 0,
		cleanupHandlers: /* @__PURE__ */ new Map()
	};
	return proc[CLEANUP_STATE_KEY];
}
function resolveWatchdogState() {
	const proc = process;
	if (!proc[WATCHDOG_STATE_KEY]) proc[WATCHDOG_STATE_KEY] = {
		started: false,
		intervalMs: DEFAULT_WATCHDOG_INTERVAL_MS
	};
	return proc[WATCHDOG_STATE_KEY];
}
function resolvePositiveMs(value, fallback, opts = {}) {
	if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return fallback;
	if (value === Number.POSITIVE_INFINITY) return opts.allowInfinity ? value : fallback;
	if (!Number.isFinite(value)) return fallback;
	return value;
}
function resolveSessionLockMaxHoldFromTimeout(params) {
	const minMs = resolvePositiveMs(params.minMs, DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS);
	const timeoutMs = resolvePositiveMs(params.timeoutMs, minMs, { allowInfinity: true });
	if (timeoutMs === Number.POSITIVE_INFINITY) return MAX_LOCK_HOLD_MS;
	const graceMs = resolvePositiveMs(params.graceMs, DEFAULT_TIMEOUT_GRACE_MS);
	return Math.min(MAX_LOCK_HOLD_MS, Math.max(minMs, timeoutMs + graceMs));
}
/**
* Synchronously release all held locks.
* Used during process exit when async operations aren't reliable.
*/
function releaseAllLocksSync() {
	SESSION_LOCKS.reset();
	stopWatchdogTimer();
}
async function runLockWatchdogCheck(nowMs = Date.now()) {
	let released = 0;
	for (const held of SESSION_LOCKS.heldEntries()) {
		const maxHoldMs = typeof held.metadata.maxHoldMs === "number" ? held.metadata.maxHoldMs : DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS;
		const heldForMs = nowMs - held.acquiredAt;
		if (heldForMs <= maxHoldMs) continue;
		process.stderr.write(`[session-write-lock] releasing lock held for ${heldForMs}ms (max=${maxHoldMs}ms): ${held.lockPath}\n`);
		if (await held.forceRelease()) released += 1;
	}
	return released;
}
function stopWatchdogTimer() {
	const watchdogState = resolveWatchdogState();
	if (watchdogState.timer) {
		clearInterval(watchdogState.timer);
		watchdogState.timer = void 0;
	}
	watchdogState.started = false;
}
function shouldStartBackgroundWatchdog() {
	return process.env.VITEST !== "true" || process.env.OPENCLAW_TEST_SESSION_LOCK_WATCHDOG === "1";
}
function ensureWatchdogStarted(intervalMs) {
	if (!shouldStartBackgroundWatchdog()) return;
	const watchdogState = resolveWatchdogState();
	if (watchdogState.started) return;
	watchdogState.started = true;
	watchdogState.intervalMs = intervalMs;
	watchdogState.timer = setInterval(() => {
		runLockWatchdogCheck().catch(() => {});
	}, intervalMs);
	watchdogState.timer.unref?.();
}
function handleTerminationSignal(signal) {
	releaseAllLocksSync();
	const cleanupState = resolveCleanupState();
	if (process.listenerCount(signal) === 1) {
		const handler = cleanupState.cleanupHandlers.get(signal);
		if (handler) {
			process.off(signal, handler);
			cleanupState.cleanupHandlers.delete(signal);
		}
		try {
			process.kill(process.pid, signal);
		} catch {}
	}
}
function registerCleanupHandlers() {
	const cleanupState = resolveCleanupState();
	cleanupState.registered = true;
	if (!cleanupState.exitHandler) {
		cleanupState.exitHandler = () => {
			releaseAllLocksSync();
		};
		process.on("exit", cleanupState.exitHandler);
	}
	ensureWatchdogStarted(DEFAULT_WATCHDOG_INTERVAL_MS);
	for (const signal of CLEANUP_SIGNALS) {
		if (cleanupState.cleanupHandlers.has(signal)) continue;
		try {
			const handler = () => handleTerminationSignal(signal);
			cleanupState.cleanupHandlers.set(signal, handler);
			process.on(signal, handler);
		} catch {}
	}
}
function unregisterCleanupHandlers() {
	const cleanupState = resolveCleanupState();
	if (cleanupState.exitHandler) {
		process.off("exit", cleanupState.exitHandler);
		cleanupState.exitHandler = void 0;
	}
	for (const [signal, handler] of cleanupState.cleanupHandlers) process.off(signal, handler);
	cleanupState.cleanupHandlers.clear();
	cleanupState.registered = false;
}
async function readLockPayload(lockPath) {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw);
		const payload = {};
		if (isValidLockNumber(parsed.pid) && parsed.pid > 0) payload.pid = parsed.pid;
		if (typeof parsed.createdAt === "string") payload.createdAt = parsed.createdAt;
		if (isValidLockNumber(parsed.starttime)) payload.starttime = parsed.starttime;
		if (isValidLockNumber(parsed.maxHoldMs) && parsed.maxHoldMs > 0) payload.maxHoldMs = parsed.maxHoldMs;
		return payload;
	} catch {
		return null;
	}
}
async function resolveNormalizedSessionFile(sessionFile) {
	const resolvedSessionFile = path.resolve(sessionFile);
	const sessionDir = path.dirname(resolvedSessionFile);
	try {
		const normalizedDir = await fs.realpath(sessionDir);
		return path.join(normalizedDir, path.basename(resolvedSessionFile));
	} catch {
		return resolvedSessionFile;
	}
}
function normalizeOwnerProcessArg(arg) {
	return arg.trim().replaceAll("\\", "/").toLowerCase();
}
function isOpenClawSessionOwnerArgv(args) {
	const normalized = args.map(normalizeOwnerProcessArg).filter(Boolean);
	if (normalized.length === 0) return false;
	const exe = (normalized[0] ?? "").replace(/\.(bat|cmd|exe)$/i, "");
	if (exe === "openclaw" || exe.endsWith("/openclaw") || exe.endsWith("/openclaw-gateway")) return true;
	if (normalized.some((arg) => arg === "openclaw" || arg.endsWith("/openclaw") || arg === "openclaw.mjs" || arg.endsWith("/openclaw.mjs"))) return true;
	const entryCandidates = [
		"dist/index.js",
		"dist/entry.js",
		"scripts/run-node.mjs",
		"src/entry.ts",
		"src/index.ts"
	];
	const hasOpenClawCommandToken = normalized.some((arg) => arg === "gateway" || arg === "agent");
	return normalized.some((arg) => entryCandidates.some((entry) => arg.endsWith(entry)) && hasOpenClawCommandToken);
}
function readOwnerProcessArgs(reader, pid) {
	try {
		const args = reader(pid);
		return Array.isArray(args) ? args : null;
	} catch {
		return null;
	}
}
function inspectLockPayload(payload, staleMs, nowMs, opts = {}) {
	const pid = isValidLockNumber(payload?.pid) && payload.pid > 0 ? payload.pid : null;
	const pidAlive = pid !== null ? isPidAlive(pid) : false;
	const createdAt = typeof payload?.createdAt === "string" ? payload.createdAt : null;
	const createdAtMs = createdAt ? Date.parse(createdAt) : NaN;
	const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : null;
	const storedStarttime = isValidLockNumber(payload?.starttime) ? payload.starttime : null;
	const pidRecycled = pidAlive && pid !== null && storedStarttime !== null ? (() => {
		const currentStarttime = resolveProcessStartTimeForLock(pid);
		return currentStarttime !== null && currentStarttime !== storedStarttime;
	})() : false;
	const staleReasons = [];
	if (pid === null) staleReasons.push("missing-pid");
	else if (!pidAlive) staleReasons.push("dead-pid");
	else if (pidRecycled) staleReasons.push("recycled-pid");
	if (ageMs === null) staleReasons.push("invalid-createdAt");
	else if (ageMs > staleMs) staleReasons.push("too-old");
	const holderMaxHoldMs = isValidLockNumber(payload?.maxHoldMs) && payload.maxHoldMs > 0 ? payload.maxHoldMs : void 0;
	if (opts.respectMaxHold === true && typeof holderMaxHoldMs === "number" && ageMs !== null && ageMs > holderMaxHoldMs) staleReasons.push("hold-exceeded");
	return {
		pid,
		pidAlive,
		createdAt,
		ageMs,
		stale: staleReasons.length > 0,
		staleReasons
	};
}
function shouldTreatAsNonOpenClawOwner(params) {
	if (params.inspected.stale || params.inspected.pid === null || !params.inspected.pidAlive) return false;
	if (params.inspected.pid === process.pid && params.heldByThisProcess) return false;
	if (!isValidLockNumber(params.payload?.pid) || params.payload.pid <= 0) return false;
	const args = readOwnerProcessArgs(params.readOwnerProcessArgs, params.payload.pid);
	if (!args || args.every((arg) => !arg.trim())) return false;
	return !isOpenClawSessionOwnerArgv(args);
}
function lockInspectionNeedsMtimeStaleFallback(details) {
	return details.stale && details.staleReasons.every((reason) => reason === "missing-pid" || reason === "invalid-createdAt");
}
async function shouldReclaimContendedLockFile(lockPath, details, staleMs, nowMs) {
	if (!details.stale) return false;
	if (!lockInspectionNeedsMtimeStaleFallback(details)) return true;
	try {
		const stat = await fs.stat(lockPath);
		return Math.max(0, nowMs - stat.mtimeMs) > Math.min(staleMs, ORPHAN_LOCK_PAYLOAD_GRACE_MS);
	} catch (error) {
		return error?.code !== "ENOENT";
	}
}
function sessionLockHeldByThisProcess(normalizedSessionFile) {
	return SESSION_LOCKS.heldEntries().some((entry) => entry.normalizedTargetPath === normalizedSessionFile);
}
function shouldTreatAsOrphanSelfLock(params) {
	if ((isValidLockNumber(params.payload?.pid) ? params.payload.pid : null) !== process.pid) return false;
	if (params.heldByThisProcess) return false;
	const storedStarttime = isValidLockNumber(params.payload?.starttime) ? params.payload.starttime : null;
	if (storedStarttime === null) return params.reclaimLockWithoutStarttime;
	const currentStarttime = resolveProcessStartTimeForLock(process.pid);
	return currentStarttime !== null && currentStarttime === storedStarttime;
}
function inspectLockPayloadForSession(params) {
	const inspected = inspectLockPayload(params.payload, params.staleMs, params.nowMs, { respectMaxHold: params.respectMaxHold });
	if (shouldTreatAsOrphanSelfLock({
		payload: params.payload,
		heldByThisProcess: params.heldByThisProcess,
		reclaimLockWithoutStarttime: params.reclaimLockWithoutStarttime
	})) return {
		...inspected,
		stale: true,
		staleReasons: inspected.staleReasons.includes("orphan-self-pid") ? inspected.staleReasons : [...inspected.staleReasons, "orphan-self-pid"]
	};
	if (shouldTreatAsNonOpenClawOwner({
		payload: params.payload,
		inspected,
		heldByThisProcess: params.heldByThisProcess,
		readOwnerProcessArgs: params.readOwnerProcessArgs
	})) return {
		...inspected,
		stale: true,
		staleReasons: [...inspected.staleReasons, "non-openclaw-owner"]
	};
	return inspected;
}
async function cleanStaleLockFiles(params) {
	const sessionsDir = path.resolve(params.sessionsDir);
	const staleMs = resolvePositiveMs(params.staleMs, resolveSessionWriteLockStaleMs(params.config, params.env));
	const removeStale = params.removeStale !== false;
	const nowMs = params.nowMs ?? Date.now();
	const ownerProcessArgsReader = params.readOwnerProcessArgs ?? readGatewayProcessArgsSync;
	let entries = [];
	try {
		entries = await fs.readdir(sessionsDir, { withFileTypes: true });
	} catch (err) {
		if (err.code === "ENOENT") return {
			locks: [],
			cleaned: []
		};
		throw err;
	}
	const locks = [];
	const cleaned = [];
	const lockEntries = entries.filter((entry) => entry.name.endsWith(".jsonl.lock")).toSorted((a, b) => a.name.localeCompare(b.name));
	for (const entry of lockEntries) {
		const lockPath = path.join(sessionsDir, entry.name);
		const lockInfo = {
			lockPath,
			...inspectLockPayloadForSession({
				payload: await readLockPayload(lockPath),
				staleMs,
				nowMs,
				heldByThisProcess: false,
				reclaimLockWithoutStarttime: false,
				readOwnerProcessArgs: ownerProcessArgsReader
			}),
			removed: false
		};
		if (lockInfo.stale && removeStale) {
			await fs.rm(lockPath, { force: true });
			lockInfo.removed = true;
			cleaned.push(lockInfo);
			params.log?.warn?.(`removed stale session lock: ${lockPath} (${lockInfo.staleReasons.join(", ") || "unknown"})`);
		}
		locks.push(lockInfo);
	}
	return {
		locks,
		cleaned
	};
}
async function acquireSessionWriteLock(params) {
	registerCleanupHandlers();
	const allowReentrant = params.allowReentrant ?? false;
	const defaultOptions = resolveSessionWriteLockOptions();
	const timeoutMs = resolvePositiveMs(params.timeoutMs, defaultOptions.timeoutMs, { allowInfinity: true });
	const staleMs = resolvePositiveMs(params.staleMs, defaultOptions.staleMs);
	const maxHoldMs = resolvePositiveMs(params.maxHoldMs, defaultOptions.maxHoldMs);
	const sessionFile = path.resolve(params.sessionFile);
	const sessionDir = path.dirname(sessionFile);
	const lockPath = `${await resolveNormalizedSessionFile(sessionFile)}.lock`;
	await fs.mkdir(sessionDir, { recursive: true });
	while (true) try {
		return { release: (await SESSION_LOCKS.acquire(sessionFile, {
			staleMs,
			timeoutMs,
			retry: {
				minTimeout: 50,
				maxTimeout: 1e3,
				factor: 1
			},
			staleRecovery: "remove-if-unchanged",
			allowReentrant,
			metadata: { maxHoldMs },
			payload: () => {
				const createdAt = (/* @__PURE__ */ new Date()).toISOString();
				const starttime = resolveProcessStartTimeForLock(process.pid);
				const lockPayload = {
					pid: process.pid,
					createdAt,
					maxHoldMs
				};
				if (starttime !== null) lockPayload.starttime = starttime;
				return lockPayload;
			},
			shouldReclaim: async ({ payload, nowMs, heldByThisProcess }) => {
				return await shouldReclaimContendedLockFile(lockPath, inspectLockPayloadForSession({
					payload,
					staleMs,
					nowMs,
					heldByThisProcess,
					reclaimLockWithoutStarttime: true,
					readOwnerProcessArgs: readGatewayProcessArgsSync,
					respectMaxHold: !heldByThisProcess
				}), staleMs, nowMs);
			},
			shouldRemoveStaleLock: async ({ lockPath, normalizedTargetPath, payload }) => {
				const nowMs = Date.now();
				const heldByThisProcess = sessionLockHeldByThisProcess(normalizedTargetPath);
				return await shouldReclaimContendedLockFile(lockPath, inspectLockPayloadForSession({
					payload,
					staleMs,
					nowMs,
					heldByThisProcess,
					reclaimLockWithoutStarttime: true,
					readOwnerProcessArgs: readGatewayProcessArgsSync,
					respectMaxHold: !heldByThisProcess
				}), staleMs, nowMs);
			}
		})).release };
	} catch (err) {
		if (!isFileLockError(err, "file_lock_timeout")) throw err;
		const timeoutLockPath = err.lockPath ?? lockPath;
		const payload = await readLockPayload(timeoutLockPath);
		throw new SessionWriteLockTimeoutError({
			timeoutMs,
			owner: typeof payload?.pid === "number" ? `pid=${payload.pid}` : "unknown",
			lockPath: timeoutLockPath
		});
	}
}
const testing = {
	cleanupSignals: [...CLEANUP_SIGNALS],
	handleTerminationSignal,
	inspectLockPayloadForTest: inspectLockPayload,
	releaseAllLocksSync,
	runLockWatchdogCheck,
	setProcessStartTimeResolverForTest(resolver) {
		resolveProcessStartTimeForLock = resolver ?? getProcessStartTime;
	}
};
async function drainSessionWriteLockStateForTest() {
	await SESSION_LOCKS.drain();
	stopWatchdogTimer();
	unregisterCleanupHandlers();
}
function resetSessionWriteLockStateForTest() {
	releaseAllLocksSync();
	stopWatchdogTimer();
	unregisterCleanupHandlers();
	resolveProcessStartTimeForLock = getProcessStartTime;
}
//#endregion
export { cleanStaleLockFiles as a, resolveSessionLockMaxHoldFromTimeout as c, resolveSessionWriteLockOptions as d, resolveSessionWriteLockStaleMs as f, acquireSessionWriteLock as i, resolveSessionWriteLockAcquireTimeoutMs as l, DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS as n, drainSessionWriteLockStateForTest as o, testing as p, DEFAULT_SESSION_WRITE_LOCK_STALE_MS as r, resetSessionWriteLockStateForTest as s, DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS as t, resolveSessionWriteLockMaxHoldMs as u };
