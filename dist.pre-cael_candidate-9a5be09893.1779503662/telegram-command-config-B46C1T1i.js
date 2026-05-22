import { n as normalizeSlashCommandName, r as resolveCustomCommands, t as normalizeCommandDescription } from "./custom-command-config-BbzXN2DE.js";
//#region src/plugin-sdk/telegram-command-config.ts
/**
* @deprecated Public SDK subpath has no bundled extension production imports.
* Use plugin-local Telegram command config handling for new plugin code.
*/
const TELEGRAM_COMMAND_NAME_PATTERN_VALUE = /^[a-z0-9_]{1,32}$/;
const TELEGRAM_CUSTOM_COMMAND_CONFIG = {
	label: "Telegram",
	pattern: TELEGRAM_COMMAND_NAME_PATTERN_VALUE,
	patternDescription: "use a-z, 0-9, underscore; max 32 chars"
};
function normalizeTelegramCommandNameImpl(value) {
	return normalizeSlashCommandName(value);
}
function normalizeTelegramCommandDescriptionImpl(value) {
	return normalizeCommandDescription(value);
}
function resolveTelegramCustomCommandsImpl(params) {
	return resolveCustomCommands({
		...params,
		config: TELEGRAM_CUSTOM_COMMAND_CONFIG
	});
}
function getTelegramCommandNamePattern() {
	return TELEGRAM_COMMAND_NAME_PATTERN_VALUE;
}
const TELEGRAM_COMMAND_NAME_PATTERN = TELEGRAM_COMMAND_NAME_PATTERN_VALUE;
function normalizeTelegramCommandName(value) {
	return normalizeTelegramCommandNameImpl(value);
}
function normalizeTelegramCommandDescription(value) {
	return normalizeTelegramCommandDescriptionImpl(value);
}
function resolveTelegramCustomCommands(params) {
	return resolveTelegramCustomCommandsImpl(params);
}
//#endregion
export { resolveTelegramCustomCommands as a, normalizeTelegramCommandName as i, getTelegramCommandNamePattern as n, normalizeTelegramCommandDescription as r, TELEGRAM_COMMAND_NAME_PATTERN as t };
