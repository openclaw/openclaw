import { ht as isPlainObject } from "./entry.js";
import { r as normalizeChannelId } from "./plugins-BOmV0yTv.js";

//#region src/config/commands.ts
function resolveAutoDefault(providerId) {
	const id = normalizeChannelId(providerId);
	if (!id) return false;
	if (id === "discord" || id === "telegram") return true;
	if (id === "slack") return false;
	return false;
}
function resolveNativeSkillsEnabled(params) {
	return resolveNativeCommandSetting(params);
}
function resolveNativeCommandsEnabled(params) {
	return resolveNativeCommandSetting(params);
}
function resolveNativeCommandSetting(params) {
	const { providerId, providerSetting, globalSetting } = params;
	const setting = providerSetting === void 0 ? globalSetting : providerSetting;
	if (setting === true) return true;
	if (setting === false) return false;
	return resolveAutoDefault(providerId);
}
function isNativeCommandsExplicitlyDisabled(params) {
	const { providerSetting, globalSetting } = params;
	if (providerSetting === false) return true;
	if (providerSetting === void 0) return globalSetting === false;
	return false;
}
function getOwnCommandFlagValue(config, key) {
	const { commands } = config ?? {};
	if (!isPlainObject(commands) || !Object.hasOwn(commands, key)) return;
	return commands[key];
}
function isCommandFlagEnabled(config, key) {
	return getOwnCommandFlagValue(config, key) === true;
}
function isRestartEnabled(config) {
	return getOwnCommandFlagValue(config, "restart") !== false;
}

//#endregion
export { resolveNativeSkillsEnabled as a, resolveNativeCommandsEnabled as i, isNativeCommandsExplicitlyDisabled as n, isRestartEnabled as r, isCommandFlagEnabled as t };