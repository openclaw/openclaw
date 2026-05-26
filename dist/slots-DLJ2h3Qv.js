//#region src/plugins/slots.ts
const SLOT_BY_KIND = {
	memory: "memory",
	"context-engine": "contextEngine"
};
const DEFAULT_SLOT_BY_KEY = {
	memory: "memory-core",
	contextEngine: "legacy"
};
/** Normalize a kind field to an array for uniform iteration. */
function normalizeKinds(kind) {
	if (!kind) return [];
	return Array.isArray(kind) ? kind : [kind];
}
/** Check whether a plugin's kind field includes a specific kind. */
function hasKind(kind, target) {
	if (!kind) return false;
	return Array.isArray(kind) ? kind.includes(target) : kind === target;
}
/** Order-insensitive equality check for two kind values (string or array). */
function kindsEqual(a, b) {
	const aN = normalizeKinds(a).toSorted();
	const bN = normalizeKinds(b).toSorted();
	return aN.length === bN.length && aN.every((k, i) => k === bN[i]);
}
/** Return all slot keys that a plugin's kind field maps to. */
function slotKeysForPluginKind(kind) {
	return normalizeKinds(kind).map((k) => SLOT_BY_KIND[k]).filter((k) => k != null);
}
function defaultSlotIdForKey(slotKey) {
	return DEFAULT_SLOT_BY_KEY[slotKey];
}
function applyExclusiveSlotSelection(params) {
	const slotKeys = slotKeysForPluginKind(params.selectedKind);
	if (slotKeys.length === 0) return {
		config: params.config,
		warnings: [],
		changed: false
	};
	const warnings = [];
	const pluginsConfig = params.config.plugins ?? {};
	let anyChanged = false;
	const entries = { ...pluginsConfig.entries };
	const slots = { ...pluginsConfig.slots };
	for (const slotKey of slotKeys) {
		const prevSlot = slots[slotKey];
		slots[slotKey] = params.selectedId;
		const inferredPrevSlot = prevSlot ?? defaultSlotIdForKey(slotKey);
		if (inferredPrevSlot && inferredPrevSlot !== params.selectedId) warnings.push(`Exclusive slot "${slotKey}" switched from "${inferredPrevSlot}" to "${params.selectedId}".`);
		const disabledIds = [];
		if (params.registry) for (const plugin of params.registry.plugins) {
			if (plugin.id === params.selectedId) continue;
			const kindForSlot = Object.keys(SLOT_BY_KIND).find((k) => SLOT_BY_KIND[k] === slotKey);
			if (!kindForSlot || !hasKind(plugin.kind, kindForSlot)) continue;
			if (Object.keys(SLOT_BY_KIND).map((k) => SLOT_BY_KIND[k]).filter((sk) => sk !== slotKey).some((sk) => (slots[sk] ?? defaultSlotIdForKey(sk)) === plugin.id)) continue;
			const entry = entries[plugin.id];
			if (!entry || entry.enabled !== false) {
				entries[plugin.id] = {
					...entry,
					enabled: false
				};
				disabledIds.push(plugin.id);
			}
		}
		if (disabledIds.length > 0) warnings.push(`Disabled other "${slotKey}" slot plugins: ${disabledIds.toSorted().join(", ")}.`);
		if (prevSlot !== params.selectedId || disabledIds.length > 0) anyChanged = true;
	}
	if (!anyChanged) return {
		config: params.config,
		warnings: [],
		changed: false
	};
	return {
		config: {
			...params.config,
			plugins: {
				...pluginsConfig,
				slots,
				entries
			}
		},
		warnings,
		changed: true
	};
}
//#endregion
export { kindsEqual as i, defaultSlotIdForKey as n, hasKind as r, applyExclusiveSlotSelection as t };
