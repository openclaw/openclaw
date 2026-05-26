import { r as emptyPluginConfigSchema } from "./config-schema-DBTUnI0T.js";
//#region src/plugin-sdk/lazy-value.ts
function createCachedLazyValueGetter(value, fallback) {
	let resolved = false;
	let cached;
	return () => {
		if (!resolved) {
			cached = (typeof value === "function" ? value() : value) ?? fallback;
			resolved = true;
		}
		return cached;
	};
}
//#endregion
//#region src/plugin-sdk/plugin-entry.ts
/**
* Canonical entry helper for non-channel plugins.
*
* Use this for provider, tool, command, service, memory, and context-engine
* plugins. Channel plugins should use `defineChannelPluginEntry(...)` from
* `openclaw/plugin-sdk/core` so they inherit the channel capability wiring.
*/
function definePluginEntry({ id, name, description, kind, configSchema = emptyPluginConfigSchema, reload, nodeHostCommands, securityAuditCollectors, register }) {
	const getConfigSchema = createCachedLazyValueGetter(configSchema);
	return {
		id,
		name,
		description,
		...kind ? { kind } : {},
		...reload ? { reload } : {},
		...nodeHostCommands ? { nodeHostCommands } : {},
		...securityAuditCollectors ? { securityAuditCollectors } : {},
		get configSchema() {
			return getConfigSchema();
		},
		register
	};
}
//#endregion
export { definePluginEntry as t };
