//#region src/plugins/plugin-cache-primitives.ts
var PluginLruCache = class {
	#defaultMaxEntries;
	#maxEntries;
	#entries = /* @__PURE__ */ new Map();
	constructor(defaultMaxEntries) {
		this.#defaultMaxEntries = normalizeMaxEntries(defaultMaxEntries, 1);
		this.#maxEntries = this.#defaultMaxEntries;
	}
	get maxEntries() {
		return this.#maxEntries;
	}
	get size() {
		return this.#entries.size;
	}
	setMaxEntriesForTest(value) {
		this.#maxEntries = typeof value === "number" ? normalizeMaxEntries(value, this.#defaultMaxEntries) : this.#defaultMaxEntries;
		this.#evictOldestEntries();
	}
	clear() {
		this.#entries.clear();
	}
	get(cacheKey) {
		const cached = this.getResult(cacheKey);
		return cached.hit ? cached.value : void 0;
	}
	getResult(cacheKey) {
		if (!this.#entries.has(cacheKey)) return { hit: false };
		const cached = this.#entries.get(cacheKey);
		this.#entries.delete(cacheKey);
		this.#entries.set(cacheKey, cached);
		return {
			hit: true,
			value: cached
		};
	}
	set(cacheKey, value) {
		if (this.#entries.has(cacheKey)) this.#entries.delete(cacheKey);
		this.#entries.set(cacheKey, value);
		this.#evictOldestEntries();
	}
	#evictOldestEntries() {
		while (this.#entries.size > this.#maxEntries) {
			const oldestEntry = this.#entries.keys().next();
			if (oldestEntry.done) break;
			this.#entries.delete(oldestEntry.value);
		}
	}
};
function resolveConfigScopedRuntimeCacheValue(params) {
	if (!params.config) return params.load();
	let configCache = params.cache.get(params.config);
	if (!configCache) {
		configCache = /* @__PURE__ */ new Map();
		params.cache.set(params.config, configCache);
	}
	if (configCache.has(params.key)) return configCache.get(params.key);
	const loaded = params.load();
	configCache.set(params.key, loaded);
	return loaded;
}
function createPluginCacheKey(parts) {
	return JSON.stringify(parts);
}
function createConfigScopedPromiseLoader(load) {
	let defaultPromise;
	let promisesByConfig = /* @__PURE__ */ new WeakMap();
	const createPromise = (config) => {
		const promise = Promise.resolve().then(() => load(config));
		promise.catch(() => {
			if (config) promisesByConfig.delete(config);
			else if (defaultPromise === promise) defaultPromise = void 0;
		});
		return promise;
	};
	return {
		async load(config) {
			if (!config) {
				defaultPromise ??= createPromise();
				return await defaultPromise;
			}
			const cached = promisesByConfig.get(config);
			if (cached) return await cached;
			const promise = createPromise(config);
			promisesByConfig.set(config, promise);
			return await promise;
		},
		clear() {
			defaultPromise = void 0;
			promisesByConfig = /* @__PURE__ */ new WeakMap();
		}
	};
}
function normalizeMaxEntries(value, fallback) {
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(1, Math.floor(value));
}
//#endregion
export { resolveConfigScopedRuntimeCacheValue as i, createConfigScopedPromiseLoader as n, createPluginCacheKey as r, PluginLruCache as t };
