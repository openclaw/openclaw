import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as normalizeChannelId, n as getLoadedChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { i as resolveReadOnlyChannelCommandDefaults } from "./read-only-command-defaults-B1U3-fyY.js";
//#region src/config/commands.ts
function resolveAutoDefault(providerId, kind, options) {
	const id = normalizeChannelId(providerId) ?? normalizeOptionalLowercaseString(providerId);
	if (!id) return false;
	if (typeof options?.autoDefault === "boolean") return options.autoDefault;
	const commandDefaults = getLoadedChannelPlugin(id)?.commands ?? (options?.config ? resolveReadOnlyChannelCommandDefaults(id, {
		...options,
		config: options.config
	}) : void 0);
	if (kind === "native") return commandDefaults?.nativeCommandsAutoEnabled === true;
	return commandDefaults?.nativeSkillsAutoEnabled === true;
}
function resolveNativeSkillsEnabled(params) {
	return resolveNativeCommandSetting({
		...params,
		kind: "nativeSkills"
	});
}
function resolveNativeCommandsEnabled(params) {
	return resolveNativeCommandSetting({
		...params,
		kind: "native"
	});
}
function resolveNativeCommandSetting(params) {
	const { providerId, providerSetting, globalSetting, kind = "native", ...options } = params;
	const setting = providerSetting === void 0 ? globalSetting : providerSetting;
	if (setting === true) return true;
	if (setting === false) return false;
	return resolveAutoDefault(providerId, kind, options);
}
function isNativeCommandsExplicitlyDisabled(params) {
	const { providerSetting, globalSetting } = params;
	if (providerSetting === false) return true;
	if (providerSetting === void 0) return globalSetting === false;
	return false;
}
//#endregion
export { resolveNativeCommandsEnabled as n, resolveNativeSkillsEnabled as r, isNativeCommandsExplicitlyDisabled as t };
