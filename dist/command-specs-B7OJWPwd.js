import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { A as pluginCommands, f as pluginCommandSupportsChannel } from "./types-Db71gsKA.js";
import { n as getLoadedChannelPlugin } from "./registry-BdfZSqhE2.js";
import "./plugins-YTdL-Pji.js";
import { i as resolveReadOnlyChannelCommandDefaults } from "./read-only-command-defaults-Bj9tN3Lb.js";
//#region src/plugins/command-specs.ts
function resolvePluginNativeName(command, provider) {
	const providerName = normalizeOptionalLowercaseString(provider);
	const providerOverride = providerName ? command.nativeNames?.[providerName] : void 0;
	if (typeof providerOverride === "string" && providerOverride.trim()) return providerOverride.trim();
	const defaultOverride = command.nativeNames?.default;
	if (typeof defaultOverride === "string" && defaultOverride.trim()) return defaultOverride.trim();
	return command.name;
}
function getPluginCommandSpecs(provider, options = {}) {
	const providerName = normalizeOptionalLowercaseString(provider);
	const commandDefaults = providerName && options.config ? resolveReadOnlyChannelCommandDefaults(providerName, {
		...options,
		config: options.config
	}) : void 0;
	if (providerName && (getLoadedChannelPlugin(providerName)?.commands ?? commandDefaults)?.nativeCommandsAutoEnabled !== true) return [];
	return listProviderPluginCommandSpecs(provider);
}
/** Resolve plugin command specs for a provider's native naming surface without support gating. */
function listProviderPluginCommandSpecs(provider) {
	return Array.from(pluginCommands.values()).filter((cmd) => pluginCommandSupportsChannel(cmd, provider)).map((cmd) => {
		const spec = {
			name: resolvePluginNativeName(cmd, provider),
			description: cmd.description,
			acceptsArgs: cmd.acceptsArgs ?? false
		};
		if (cmd.descriptionLocalizations) spec.descriptionLocalizations = cmd.descriptionLocalizations;
		return spec;
	});
}
//#endregion
export { listProviderPluginCommandSpecs as n, getPluginCommandSpecs as t };
