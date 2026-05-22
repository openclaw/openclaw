import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/shared/custom-command-config.ts
const DEFAULT_PREFIX = "/";
function normalizeSlashCommandName(value) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return normalizeLowercaseStringOrEmpty(trimmed.startsWith(DEFAULT_PREFIX) ? trimmed.slice(1) : trimmed).replace(/-/g, "_");
}
function normalizeCommandDescription(value) {
	return value.trim();
}
function resolveCustomCommands(params) {
	const entries = Array.isArray(params.commands) ? params.commands : [];
	const reserved = params.reservedCommands ?? /* @__PURE__ */ new Set();
	const checkReserved = params.checkReserved !== false;
	const checkDuplicates = params.checkDuplicates !== false;
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	const issues = [];
	const label = params.config.label;
	const prefix = params.config.prefix ?? DEFAULT_PREFIX;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const normalized = normalizeSlashCommandName(entry?.command ?? "");
		if (!normalized) {
			issues.push({
				index,
				field: "command",
				message: `${label} custom command is missing a command name.`
			});
			continue;
		}
		if (!params.config.pattern.test(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `${label} custom command "${prefix}${normalized}" is invalid (${params.config.patternDescription}).`
			});
			continue;
		}
		if (checkReserved && reserved.has(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `${label} custom command "${prefix}${normalized}" conflicts with a native command.`
			});
			continue;
		}
		if (checkDuplicates && seen.has(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `${label} custom command "${prefix}${normalized}" is duplicated.`
			});
			continue;
		}
		const description = normalizeCommandDescription(entry?.description ?? "");
		if (!description) {
			issues.push({
				index,
				field: "description",
				message: `${label} custom command "${prefix}${normalized}" is missing a description.`
			});
			continue;
		}
		if (checkDuplicates) seen.add(normalized);
		resolved.push({
			command: normalized,
			description
		});
	}
	return {
		commands: resolved,
		issues
	};
}
//#endregion
export { normalizeSlashCommandName as n, resolveCustomCommands as r, normalizeCommandDescription as t };
