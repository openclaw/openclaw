//#region src/plugin-sdk/runtime-store.ts
const pluginRuntimeStoreRegistryKey = Symbol.for("openclaw.plugin-sdk.runtime-store-registry");
function getPluginRuntimeStoreRegistry() {
	const globalRecord = globalThis;
	globalRecord[pluginRuntimeStoreRegistryKey] ??= /* @__PURE__ */ new Map();
	return globalRecord[pluginRuntimeStoreRegistryKey];
}
function pluginRuntimeStoreKeyForPluginId(pluginId) {
	const normalizedPluginId = pluginId.trim();
	if (!normalizedPluginId) throw new Error("createPluginRuntimeStore: pluginId must not be empty");
	return `plugin-runtime:${normalizedPluginId}`;
}
function resolvePluginRuntimeStoreOptions(options) {
	if (typeof options === "string") return {
		key: options,
		errorMessage: options
	};
	if ("pluginId" in options) return {
		key: pluginRuntimeStoreKeyForPluginId(options.pluginId),
		errorMessage: options.errorMessage
	};
	return options;
}
function createPluginRuntimeStore(options) {
	const resolved = resolvePluginRuntimeStoreOptions(options);
	const slot = typeof options === "string" ? { runtime: null } : (() => {
		const registry = getPluginRuntimeStoreRegistry();
		let existingSlot = registry.get(resolved.key);
		if (!existingSlot) {
			existingSlot = { runtime: null };
			registry.set(resolved.key, existingSlot);
		}
		return existingSlot;
	})();
	return {
		setRuntime(next) {
			slot.runtime = next;
		},
		clearRuntime() {
			slot.runtime = null;
		},
		tryGetRuntime() {
			return slot.runtime ?? null;
		},
		getRuntime() {
			if (slot.runtime === null) throw new Error(resolved.errorMessage);
			return slot.runtime;
		}
	};
}
//#endregion
export { createPluginRuntimeStore as t };
