//#region src/shared/scoped-expiring-id-cache.ts
function createScopedExpiringIdCache(options) {
	const ttlMs = Math.max(0, options.ttlMs);
	const cleanupThreshold = Math.max(1, Math.floor(options.cleanupThreshold));
	function cleanupExpired(scopeKey, entry, now) {
		for (const [id, timestamp] of entry) if (now - timestamp > ttlMs) entry.delete(id);
		if (entry.size === 0) options.store.delete(scopeKey);
	}
	return {
		record: (scope, id, now = Date.now()) => {
			const scopeKey = String(scope);
			const idKey = String(id);
			let entry = options.store.get(scopeKey);
			if (!entry) {
				entry = /* @__PURE__ */ new Map();
				options.store.set(scopeKey, entry);
			}
			entry.set(idKey, now);
			if (entry.size > cleanupThreshold) cleanupExpired(scopeKey, entry, now);
		},
		has: (scope, id, now = Date.now()) => {
			const scopeKey = String(scope);
			const idKey = String(id);
			const entry = options.store.get(scopeKey);
			if (!entry) return false;
			cleanupExpired(scopeKey, entry, now);
			return entry.has(idKey);
		},
		clear: () => {
			options.store.clear();
		}
	};
}
//#endregion
export { createScopedExpiringIdCache as t };
