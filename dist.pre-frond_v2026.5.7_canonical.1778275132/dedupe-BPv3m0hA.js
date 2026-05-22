import { n as resolveGlobalSingleton } from "./global-singleton-DZyLAEQq.js";
import { t as pruneMapToMaxSize } from "./map-size-DVcVB0gJ.js";
//#region src/infra/dedupe.ts
function createDedupeCache(options) {
	const ttlMs = Math.max(0, options.ttlMs);
	const maxSize = Math.max(0, Math.floor(options.maxSize));
	const cache = /* @__PURE__ */ new Map();
	const touch = (key, now) => {
		cache.delete(key);
		cache.set(key, now);
	};
	const prune = (now) => {
		const cutoff = ttlMs > 0 ? now - ttlMs : void 0;
		if (cutoff !== void 0) {
			for (const [entryKey, entryTs] of cache) if (entryTs < cutoff) cache.delete(entryKey);
		}
		if (maxSize <= 0) {
			cache.clear();
			return;
		}
		pruneMapToMaxSize(cache, maxSize);
	};
	const hasUnexpired = (key, now, touchOnRead) => {
		const existing = cache.get(key);
		if (existing === void 0) return false;
		if (ttlMs > 0 && now - existing >= ttlMs) {
			cache.delete(key);
			return false;
		}
		if (touchOnRead) touch(key, now);
		return true;
	};
	return {
		check: (key, now = Date.now()) => {
			if (!key) return false;
			if (hasUnexpired(key, now, true)) return true;
			touch(key, now);
			prune(now);
			return false;
		},
		peek: (key, now = Date.now()) => {
			if (!key) return false;
			return hasUnexpired(key, now, false);
		},
		delete: (key) => {
			if (!key) return;
			cache.delete(key);
		},
		clear: () => {
			cache.clear();
		},
		size: () => cache.size
	};
}
function resolveGlobalDedupeCache(key, options) {
	return resolveGlobalSingleton(key, () => createDedupeCache(options));
}
//#endregion
export { resolveGlobalDedupeCache as n, createDedupeCache as t };
