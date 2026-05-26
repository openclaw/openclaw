import { o as withFileLock } from "./file-lock-D5OTq3qW.js";
import { t as createDedupeCache } from "./dedupe-BD30U36x.js";
import { i as writeJsonFileAtomically, n as readJsonFileWithFallback } from "./json-store-ChgPP2Sf.js";
//#region src/plugin-sdk/persistent-dedupe.ts
const DEFAULT_LOCK_OPTIONS = {
	retries: {
		retries: 6,
		factor: 1.35,
		minTimeout: 8,
		maxTimeout: 180,
		randomize: true
	},
	stale: 6e4
};
function mergeLockOptions(overrides) {
	return {
		stale: overrides?.stale ?? DEFAULT_LOCK_OPTIONS.stale,
		retries: {
			retries: overrides?.retries?.retries ?? DEFAULT_LOCK_OPTIONS.retries.retries,
			factor: overrides?.retries?.factor ?? DEFAULT_LOCK_OPTIONS.retries.factor,
			minTimeout: overrides?.retries?.minTimeout ?? DEFAULT_LOCK_OPTIONS.retries.minTimeout,
			maxTimeout: overrides?.retries?.maxTimeout ?? DEFAULT_LOCK_OPTIONS.retries.maxTimeout,
			randomize: overrides?.retries?.randomize ?? DEFAULT_LOCK_OPTIONS.retries.randomize
		}
	};
}
function sanitizeData(value) {
	if (!value || typeof value !== "object") return {};
	const out = {};
	for (const [key, ts] of Object.entries(value)) if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) out[key] = ts;
	return out;
}
function pruneData(data, now, ttlMs, maxEntries) {
	if (ttlMs > 0) {
		for (const [key, ts] of Object.entries(data)) if (now - ts >= ttlMs) delete data[key];
	}
	const keys = Object.keys(data);
	if (keys.length <= maxEntries) return;
	keys.toSorted((a, b) => data[a] - data[b]).slice(0, keys.length - maxEntries).forEach((key) => {
		delete data[key];
	});
}
function resolveNamespace(namespace) {
	return namespace?.trim() || "global";
}
function resolveScopedKey(namespace, key) {
	return `${namespace}:${key}`;
}
function isRecentTimestamp(seenAt, ttlMs, now) {
	return seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs);
}
/** Create a dedupe helper that combines in-memory fast checks with a lock-protected disk store. */
function createPersistentDedupe(options) {
	const ttlMs = Math.max(0, Math.floor(options.ttlMs));
	const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
	const fileMaxEntries = Math.max(1, Math.floor(options.fileMaxEntries));
	const lockOptions = mergeLockOptions(options.lockOptions);
	const memory = createDedupeCache({
		ttlMs,
		maxSize: memoryMaxSize
	});
	const inflight = /* @__PURE__ */ new Map();
	const fileWriteQueues = /* @__PURE__ */ new Map();
	function enqueueFileWrite(filePath, fn) {
		const next = (fileWriteQueues.get(filePath) ?? Promise.resolve()).then(fn, fn);
		fileWriteQueues.set(filePath, next);
		next.finally(() => {
			if (fileWriteQueues.get(filePath) === next) fileWriteQueues.delete(filePath);
		}).catch(() => {});
		return next;
	}
	async function checkAndRecordInner(key, namespace, scopedKey, now, onDiskError) {
		if (memory.check(scopedKey, now)) return false;
		const path = options.resolveFilePath(namespace);
		try {
			return !await enqueueFileWrite(path, () => withFileLock(path, lockOptions, async () => {
				const { value } = await readJsonFileWithFallback(path, {});
				const data = sanitizeData(value);
				const seenAt = data[key];
				if (seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs)) return true;
				data[key] = now;
				pruneData(data, now, ttlMs, fileMaxEntries);
				await writeJsonFileAtomically(path, data);
				return false;
			}));
		} catch (error) {
			onDiskError?.(error);
			memory.check(scopedKey, now);
			return true;
		}
	}
	async function hasRecentInner(key, namespace, scopedKey, now, onDiskError) {
		if (memory.peek(scopedKey, now)) return true;
		const path = options.resolveFilePath(namespace);
		try {
			const { value } = await readJsonFileWithFallback(path, {});
			const seenAt = sanitizeData(value)[key];
			if (!isRecentTimestamp(seenAt, ttlMs, now)) return false;
			memory.check(scopedKey, seenAt);
			return true;
		} catch (error) {
			onDiskError?.(error);
			return memory.peek(scopedKey, now);
		}
	}
	async function warmup(namespace = "global", onError) {
		const filePath = options.resolveFilePath(namespace);
		const now = Date.now();
		try {
			const { value } = await readJsonFileWithFallback(filePath, {});
			const data = sanitizeData(value);
			let loaded = 0;
			for (const [key, ts] of Object.entries(data)) {
				if (ttlMs > 0 && now - ts >= ttlMs) continue;
				const scopedKey = `${namespace}:${key}`;
				memory.check(scopedKey, ts);
				loaded++;
			}
			return loaded;
		} catch (error) {
			onError?.(error);
			return 0;
		}
	}
	async function checkAndRecord(key, dedupeOptions) {
		const trimmed = key.trim();
		if (!trimmed) return true;
		const namespace = resolveNamespace(dedupeOptions?.namespace);
		const scopedKey = resolveScopedKey(namespace, trimmed);
		if (inflight.has(scopedKey)) return false;
		const onDiskError = dedupeOptions?.onDiskError ?? options.onDiskError;
		const work = checkAndRecordInner(trimmed, namespace, scopedKey, dedupeOptions?.now ?? Date.now(), onDiskError);
		inflight.set(scopedKey, work);
		try {
			return await work;
		} finally {
			inflight.delete(scopedKey);
		}
	}
	async function hasRecent(key, dedupeOptions) {
		const trimmed = key.trim();
		if (!trimmed) return false;
		const namespace = resolveNamespace(dedupeOptions?.namespace);
		const scopedKey = resolveScopedKey(namespace, trimmed);
		const onDiskError = dedupeOptions?.onDiskError ?? options.onDiskError;
		return hasRecentInner(trimmed, namespace, scopedKey, dedupeOptions?.now ?? Date.now(), onDiskError);
	}
	return {
		checkAndRecord,
		hasRecent,
		warmup,
		clearMemory: () => memory.clear(),
		memorySize: () => memory.size()
	};
}
function createReleasedClaimError(scopedKey) {
	return /* @__PURE__ */ new Error(`claim released before commit: ${scopedKey}`);
}
/** Create a claim/commit/release dedupe guard backed by memory and optional persistent storage. */
function createClaimableDedupe(options) {
	const ttlMs = Math.max(0, Math.floor(options.ttlMs));
	const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
	const memory = createDedupeCache({
		ttlMs,
		maxSize: memoryMaxSize
	});
	const persistent = options.resolveFilePath != null ? createPersistentDedupe({
		ttlMs,
		memoryMaxSize,
		fileMaxEntries: Math.max(1, Math.floor(options.fileMaxEntries)),
		resolveFilePath: options.resolveFilePath,
		lockOptions: options.lockOptions,
		onDiskError: options.onDiskError
	}) : null;
	const inflight = /* @__PURE__ */ new Map();
	async function hasRecent(key, dedupeOptions) {
		const trimmed = key.trim();
		if (!trimmed) return false;
		const scopedKey = resolveScopedKey(resolveNamespace(dedupeOptions?.namespace), trimmed);
		if (persistent) return persistent.hasRecent(trimmed, dedupeOptions);
		return memory.peek(scopedKey, dedupeOptions?.now);
	}
	async function claim(key, dedupeOptions) {
		const trimmed = key.trim();
		if (!trimmed) return { kind: "claimed" };
		const scopedKey = resolveScopedKey(resolveNamespace(dedupeOptions?.namespace), trimmed);
		const existing = inflight.get(scopedKey);
		if (existing) return {
			kind: "inflight",
			pending: existing.promise
		};
		let resolve;
		let reject;
		const promise = new Promise((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		promise.catch(() => {});
		inflight.set(scopedKey, {
			promise,
			resolve,
			reject
		});
		try {
			if (await hasRecent(trimmed, dedupeOptions)) {
				resolve(false);
				inflight.delete(scopedKey);
				return { kind: "duplicate" };
			}
			return { kind: "claimed" };
		} catch (error) {
			reject(error);
			inflight.delete(scopedKey);
			throw error;
		}
	}
	async function commit(key, dedupeOptions) {
		const trimmed = key.trim();
		if (!trimmed) return true;
		const scopedKey = resolveScopedKey(resolveNamespace(dedupeOptions?.namespace), trimmed);
		const claim = inflight.get(scopedKey);
		try {
			const recorded = persistent ? await persistent.checkAndRecord(trimmed, dedupeOptions) : !memory.check(scopedKey, dedupeOptions?.now);
			claim?.resolve(recorded);
			return recorded;
		} catch (error) {
			claim?.reject(error);
			throw error;
		} finally {
			inflight.delete(scopedKey);
		}
	}
	function release(key, dedupeOptions) {
		const trimmed = key.trim();
		if (!trimmed) return;
		const scopedKey = resolveScopedKey(resolveNamespace(dedupeOptions?.namespace), trimmed);
		const claim = inflight.get(scopedKey);
		if (!claim) return;
		claim.reject(dedupeOptions?.error ?? createReleasedClaimError(scopedKey));
		inflight.delete(scopedKey);
	}
	return {
		claim,
		commit,
		release,
		hasRecent,
		warmup: persistent?.warmup ?? (async () => 0),
		clearMemory: () => {
			persistent?.clearMemory();
			memory.clear();
		},
		memorySize: () => persistent?.memorySize() ?? memory.size()
	};
}
//#endregion
export { createPersistentDedupe as n, createClaimableDedupe as t };
