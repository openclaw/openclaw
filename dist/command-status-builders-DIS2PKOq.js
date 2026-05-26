import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as isCommandFlagEnabled } from "./commands.flags-CeKA8V9z.js";
import { t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { n as listPluginCommands } from "./commands-knen7QS8.js";
import { n as listChatCommands, r as listChatCommandsForConfig } from "./commands-registry-list--98FRviq.js";
import "./commands-registry-Bthd8JBl.js";
//#region src/auto-reply/command-status-builders.ts
const CATEGORY_LABELS = {
	session: "Session",
	options: "Options",
	status: "Status",
	management: "Management",
	media: "Media",
	tools: "Tools",
	docks: "Docks"
};
const CATEGORY_ORDER = [
	"session",
	"options",
	"status",
	"management",
	"media",
	"tools",
	"docks"
];
function groupCommandsByCategory(commands) {
	const grouped = /* @__PURE__ */ new Map();
	for (const category of CATEGORY_ORDER) grouped.set(category, []);
	for (const command of commands) {
		const category = command.category ?? "tools";
		const list = grouped.get(category) ?? [];
		list.push(command);
		grouped.set(category, list);
	}
	return grouped;
}
function buildHelpMessage(cfg) {
	const lines = ["ℹ️ Help", ""];
	lines.push("Session");
	lines.push("  /new  |  /reset  |  /compact [instructions]  |  /stop");
	lines.push("");
	const optionParts = [
		"/think <level|default>",
		"/model <id>",
		"/fast status|on|off|default",
		"/verbose on|off|full",
		"/trace on|off|raw"
	];
	if (isCommandFlagEnabled(cfg, "config")) optionParts.push("/config");
	if (isCommandFlagEnabled(cfg, "debug")) optionParts.push("/debug");
	lines.push("Options");
	lines.push(`  ${optionParts.join("  |  ")}`);
	lines.push("");
	lines.push("Status");
	lines.push("  /status  |  /tasks  |  /whoami  |  /context");
	lines.push("");
	lines.push("Skills");
	lines.push("  /skill <name> [input]");
	lines.push("");
	lines.push("More: /commands for full list, /tools for available capabilities");
	return lines.join("\n");
}
const COMMANDS_PER_PAGE = 8;
function formatCommandEntry(command) {
	const primary = command.nativeName ? `/${command.nativeName}` : normalizeOptionalString(command.textAliases[0]) || `/${command.key}`;
	const seen = /* @__PURE__ */ new Set();
	const aliases = command.textAliases.map((alias) => alias.trim()).filter(Boolean).filter((alias) => normalizeLowercaseStringOrEmpty(alias) !== normalizeLowercaseStringOrEmpty(primary)).filter((alias) => {
		const key = normalizeLowercaseStringOrEmpty(alias);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return `${primary}${aliases.length ? ` (${aliases.join(", ")})` : ""}${command.scope === "text" ? " [text]" : ""} - ${command.description}`;
}
function buildCommandItems(commands, pluginCommands) {
	const grouped = groupCommandsByCategory(commands);
	const items = [];
	for (const category of CATEGORY_ORDER) {
		const categoryCommands = grouped.get(category) ?? [];
		if (categoryCommands.length === 0) continue;
		const label = CATEGORY_LABELS[category];
		for (const command of categoryCommands) items.push({
			label,
			text: formatCommandEntry(command)
		});
	}
	for (const command of pluginCommands) {
		const pluginLabel = command.pluginId ? ` (${command.pluginId})` : "";
		items.push({
			label: "Plugins",
			text: `/${command.name}${pluginLabel} - ${command.description}`
		});
	}
	return items;
}
function formatCommandList(items) {
	const lines = [];
	let currentLabel = null;
	for (const item of items) {
		if (item.label !== currentLabel) {
			if (lines.length > 0) lines.push("");
			lines.push(item.label);
			currentLabel = item.label;
		}
		lines.push(`  ${item.text}`);
	}
	return lines.join("\n");
}
function buildCommandsMessage(cfg, skillCommands, options) {
	return buildCommandsMessagePaginated(cfg, skillCommands, options).text;
}
function buildCommandsMessagePaginated(cfg, skillCommands, options) {
	const page = Math.max(1, options?.page ?? 1);
	const surface = normalizeOptionalLowercaseString(options?.surface);
	const prefersPaginatedList = options?.forcePaginatedList === true || Boolean(surface && getChannelPlugin(surface)?.commands?.buildCommandsListChannelData);
	const items = buildCommandItems(cfg ? listChatCommandsForConfig(cfg, { skillCommands }) : listChatCommands({ skillCommands }), listPluginCommands());
	if (!prefersPaginatedList) {
		const lines = ["ℹ️ Slash commands", ""];
		lines.push(formatCommandList(items));
		lines.push("", "More: /tools for available capabilities");
		return {
			text: lines.join("\n").trim(),
			totalPages: 1,
			currentPage: 1,
			hasNext: false,
			hasPrev: false
		};
	}
	const totalCommands = items.length;
	const totalPages = Math.max(1, Math.ceil(totalCommands / COMMANDS_PER_PAGE));
	const currentPage = Math.min(page, totalPages);
	const startIndex = (currentPage - 1) * COMMANDS_PER_PAGE;
	const endIndex = startIndex + COMMANDS_PER_PAGE;
	const pageItems = items.slice(startIndex, endIndex);
	const lines = [`ℹ️ Commands (${currentPage}/${totalPages})`, ""];
	lines.push(formatCommandList(pageItems));
	return {
		text: lines.join("\n").trim(),
		totalPages,
		currentPage,
		hasNext: currentPage < totalPages,
		hasPrev: currentPage > 1
	};
}
//#endregion
export { buildCommandsMessagePaginated as n, buildHelpMessage as r, buildCommandsMessage as t };
