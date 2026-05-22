import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { c as isRecord } from "./utils-D5swhEXt.js";
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
function resolveManifestCommandAliasOwnerInRegistry(params) {
	const normalizedCommand = normalizeOptionalLowercaseString(params.command);
	if (!normalizedCommand) return;
	if (params.registry.plugins.some((plugin) => normalizeOptionalLowercaseString(plugin.id) === normalizedCommand)) return;
	for (const plugin of params.registry.plugins) {
		const alias = plugin.commandAliases?.find((entry) => normalizeOptionalLowercaseString(entry.name) === normalizedCommand);
		if (alias) return {
			...alias,
			pluginId: plugin.id,
			...plugin.enabledByDefault === true ? { enabledByDefault: true } : {}
		};
	}
}
//#endregion
export { resolveManifestCommandAliasOwnerInRegistry as n, normalizeManifestCommandAliases as t };
