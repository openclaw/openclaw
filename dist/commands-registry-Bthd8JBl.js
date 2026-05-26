import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { n as getLoadedChannelPlugin, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { r as buildConfiguredModelCatalog, v as resolveConfiguredModelRef } from "./model-selection-shared-ClxdEp4X.js";
import "./model-selection-P-81eBKx.js";
import { t as getChatCommands } from "./commands-registry.data-piUeltWc.js";
import { n as listChatCommands, r as listChatCommandsForConfig } from "./commands-registry-list--98FRviq.js";
import { r as normalizeCommandBody } from "./commands-registry-normalize-CnHNsvCE.js";
import "./commands-text-routing-C2SuW22t.js";
//#region src/auto-reply/commands-registry.ts
function resolveNativeName(command, provider, options) {
	if (!command.nativeName) return;
	if (!provider) return command.nativeName;
	return (options?.includeBundledChannelFallback === false ? getLoadedChannelPlugin(provider) : getChannelPlugin(provider))?.commands?.resolveNativeCommandName?.({
		commandKey: command.key,
		defaultName: command.nativeName
	}) ?? command.nativeName;
}
function toNativeCommandSpec(command, provider) {
	const spec = {
		name: resolveNativeName(command, provider) ?? command.key,
		description: command.description,
		acceptsArgs: Boolean(command.acceptsArgs),
		args: command.args
	};
	if (command.descriptionLocalizations) spec.descriptionLocalizations = command.descriptionLocalizations;
	return spec;
}
function resolveNativeNames(command, provider) {
	return [resolveNativeName(command, provider), ...command.nativeAliases ?? []].filter((name) => Boolean(name));
}
function listNativeSpecsFromCommands(commands, provider) {
	return commands.filter((command) => command.scope !== "text" && command.nativeName).flatMap((command) => {
		const spec = toNativeCommandSpec(command, provider);
		return resolveNativeNames(command, provider).map((name) => {
			const nativeSpec = {
				name,
				description: spec.description,
				acceptsArgs: spec.acceptsArgs
			};
			if (spec.args) nativeSpec.args = spec.args;
			if (spec.descriptionLocalizations) nativeSpec.descriptionLocalizations = spec.descriptionLocalizations;
			return nativeSpec;
		});
	});
}
function listNativeCommandSpecs(params) {
	return listNativeSpecsFromCommands(listChatCommands({ skillCommands: params?.skillCommands }), params?.provider);
}
function listNativeCommandSpecsForConfig(cfg, params) {
	return listNativeSpecsFromCommands(listChatCommandsForConfig(cfg, params), params?.provider);
}
function findCommandByNativeName(name, provider, options) {
	const normalized = normalizeOptionalLowercaseString(name);
	if (!normalized) return;
	return getChatCommands().find((command) => command.scope !== "text" && [resolveNativeName(command, provider, options), ...command.nativeAliases ?? []].some((name) => normalizeOptionalLowercaseString(name) === normalized));
}
function buildCommandText(commandName, args) {
	const trimmedArgs = args?.trim();
	return trimmedArgs ? `/${commandName} ${trimmedArgs}` : `/${commandName}`;
}
function parsePositionalArgs(definitions, raw) {
	const values = {};
	const trimmed = raw.trim();
	if (!trimmed) return values;
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	let index = 0;
	for (const definition of definitions) {
		if (index >= tokens.length) break;
		if (definition.captureRemaining) {
			values[definition.name] = tokens.slice(index).join(" ");
			index = tokens.length;
			break;
		}
		values[definition.name] = tokens[index];
		index += 1;
	}
	return values;
}
function formatPositionalArgs(definitions, values) {
	const parts = [];
	for (const definition of definitions) {
		const value = values[definition.name];
		if (value == null) continue;
		let rendered;
		if (typeof value === "string") rendered = value.trim();
		else rendered = String(value);
		if (!rendered) continue;
		parts.push(rendered);
		if (definition.captureRemaining) break;
	}
	return parts.length > 0 ? parts.join(" ") : void 0;
}
function parseCommandArgs(command, raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return;
	if (!command.args || command.argsParsing === "none") return { raw: trimmed };
	return {
		raw: trimmed,
		values: parsePositionalArgs(command.args, trimmed)
	};
}
function serializeCommandArgs(command, args) {
	if (!args) return;
	const raw = args.raw?.trim();
	if (raw) return raw;
	if (!args.values || !command.args) return;
	if (command.formatArgs) return command.formatArgs(args.values);
	return formatPositionalArgs(command.args, args.values);
}
function buildCommandTextFromArgs(command, args) {
	return buildCommandText(command.nativeName ?? command.key, serializeCommandArgs(command, args));
}
function resolveDefaultCommandContext(cfg) {
	const resolved = resolveConfiguredModelRef({
		cfg: cfg ?? {},
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	return {
		provider: resolved.provider ?? "openai",
		model: resolved.model ?? "gpt-5.5"
	};
}
function resolveCommandArgChoices(params) {
	const { command, arg, cfg } = params;
	if (!arg.choices) return [];
	const provided = arg.choices;
	return (Array.isArray(provided) ? provided : (() => {
		const defaults = resolveDefaultCommandContext(cfg);
		return provided({
			cfg,
			provider: params.provider ?? defaults.provider,
			model: params.model ?? defaults.model,
			catalog: params.catalog ?? (cfg ? buildConfiguredModelCatalog({ cfg }) : void 0),
			command,
			arg
		});
	})()).map((choice) => typeof choice === "string" ? {
		value: choice,
		label: choice
	} : choice);
}
function resolveCommandArgMenu(params) {
	const { command, args, cfg, provider, model, catalog } = params;
	if (!command.args || !command.argsMenu) return null;
	if (command.argsParsing === "none") return null;
	const resolvedCatalog = catalog ?? (cfg ? buildConfiguredModelCatalog({ cfg }) : void 0);
	const argSpec = command.argsMenu;
	const argName = argSpec === "auto" ? command.args.find((arg) => resolveCommandArgChoices({
		command,
		arg,
		cfg,
		provider,
		model,
		catalog: resolvedCatalog
	}).length > 0)?.name : argSpec.arg;
	if (!argName) return null;
	if (args?.values && args.values[argName] != null) return null;
	if (args?.raw && !args.values) return null;
	const arg = command.args.find((entry) => entry.name === argName);
	if (!arg) return null;
	const choices = resolveCommandArgChoices({
		command,
		arg,
		cfg,
		provider,
		model,
		catalog: resolvedCatalog
	});
	if (choices.length === 0) return null;
	return {
		arg,
		choices,
		title: argSpec !== "auto" ? argSpec.title : void 0
	};
}
function formatCommandArgMenuTitle(params) {
	const { command, menu } = params;
	if (menu.title) return menu.title;
	const commandLabel = command.nativeName ?? command.key;
	if (typeof menu.arg.choices === "function") {
		const options = menu.choices.map((choice) => choice.label.trim()).filter(Boolean).join(", ");
		if (options.length > 0 && options.length <= 160) return `Choose ${menu.arg.name} for /${commandLabel}.\nOptions: ${options}.`;
		return `Choose ${menu.arg.name} for /${commandLabel}.`;
	}
	return `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
}
function isCommandMessage(raw) {
	return normalizeCommandBody(raw).startsWith("/");
}
//#endregion
export { isCommandMessage as a, parseCommandArgs as c, serializeCommandArgs as d, formatCommandArgMenuTitle as i, resolveCommandArgChoices as l, buildCommandTextFromArgs as n, listNativeCommandSpecs as o, findCommandByNativeName as r, listNativeCommandSpecsForConfig as s, buildCommandText as t, resolveCommandArgMenu as u };
