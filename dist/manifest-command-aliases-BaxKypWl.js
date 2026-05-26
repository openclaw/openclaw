import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
//#region src/plugins/manifest-command-aliases.ts
function normalizeManifestCommandAliases(value) {
	if (!Array.isArray(value)) return;
	const normalized = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			const name = normalizeOptionalString(entry) ?? "";
			if (name) normalized.push({ name });
			continue;
		}
		if (!isRecord(entry)) continue;
		const name = normalizeOptionalString(entry.name) ?? "";
		if (!name) continue;
		const kind = entry.kind === "runtime-slash" ? entry.kind : void 0;
		const cliCommand = normalizeOptionalString(entry.cliCommand) ?? "";
		normalized.push({
			name,
			...kind ? { kind } : {},
			...cliCommand ? { cliCommand } : {}
		});
	}
	return normalized.length > 0 ? normalized : void 0;
}
function resolveManifestToolOwnerInRegistry(params) {
	const normalizedToolName = normalizeOptionalLowercaseString(params.toolName);
	if (!normalizedToolName) return;
	for (const plugin of params.registry.plugins) {
		const tools = plugin.contracts?.tools;
		if (!tools || tools.length === 0) continue;
		const match = tools.find((entry) => normalizeOptionalLowercaseString(entry) === normalizedToolName);
		if (match) return {
			toolName: match,
			pluginId: plugin.id
		};
	}
}
function resolveManifestCommandAliasOwnerInRegistry(params) {
	const normalizedCommand = normalizeOptionalLowercaseString(params.command);
	if (!normalizedCommand) return;
	const commandIsPluginId = params.registry.plugins.some((plugin) => normalizeOptionalLowercaseString(plugin.id) === normalizedCommand);
	for (const plugin of params.registry.plugins) {
		const alias = plugin.commandAliases?.find((entry) => normalizeOptionalLowercaseString(entry.name) === normalizedCommand);
		if (alias) {
			if (commandIsPluginId && normalizeOptionalLowercaseString(plugin.id) !== normalizedCommand) continue;
			return {
				...alias,
				pluginId: plugin.id,
				...plugin.enabledByDefault === true ? { enabledByDefault: true } : {}
			};
		}
	}
}
//#endregion
export { resolveManifestCommandAliasOwnerInRegistry as n, resolveManifestToolOwnerInRegistry as r, normalizeManifestCommandAliases as t };
