import { p as resolvePrimaryStringValue } from "./string-coerce-DyL154ka.js";
import { t as CONFIG_PATH } from "./paths-Cw7f9XhU.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { t as OpenClawSchema } from "./zod-schema-Dsy5tXpj.js";
import "./config-B6Oplu5W.js";
import { t as note } from "./note-Dg2Luaaq.js";
import path from "node:path";
//#region src/commands/doctor-config-analysis.ts
function normalizeIssuePath(path) {
	return path.filter((part) => typeof part !== "symbol");
}
function isUnrecognizedKeysIssue(issue) {
	return issue.code === "unrecognized_keys";
}
function formatConfigPath(parts) {
	if (parts.length === 0) return "<root>";
	let out = "";
	for (const part of parts) {
		if (typeof part === "number") {
			out += `[${part}]`;
			continue;
		}
		out = out ? `${out}.${part}` : part;
	}
	return out || "<root>";
}
function resolveConfigPathTarget(root, path) {
	let current = root;
	for (const part of path) {
		if (typeof part === "number") {
			if (!Array.isArray(current)) return null;
			if (part < 0 || part >= current.length) return null;
			current = current[part];
			continue;
		}
		if (!current || typeof current !== "object" || Array.isArray(current)) return null;
		const record = current;
		if (!(part in record)) return null;
		current = record[part];
	}
	return current;
}
function isUpdateInProgress() {
	const value = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
	return value === "1" || value === "true";
}
const ROOT_STRIP_PROTECTED_KEYS = new Set(["defaultModel"]);
const STRIP_PROTECTED_KEYS = { plugins: new Set(["installs"]) };
function stripUnknownConfigKeys(config) {
	if (isUpdateInProgress()) return {
		config,
		removed: []
	};
	const parsed = OpenClawSchema.safeParse(config);
	if (parsed.success) return {
		config,
		removed: []
	};
	const next = structuredClone(config);
	const removed = [];
	for (const issue of parsed.error.issues) {
		if (!isUnrecognizedKeysIssue(issue)) continue;
		const issuePath = normalizeIssuePath(issue.path);
		const target = resolveConfigPathTarget(next, issuePath);
		if (!target || typeof target !== "object" || Array.isArray(target)) continue;
		const record = target;
		const parentKey = issuePath.length === 1 && typeof issuePath[0] === "string" ? issuePath[0] : void 0;
		const protectedSet = issuePath.length === 0 ? ROOT_STRIP_PROTECTED_KEYS : parentKey ? STRIP_PROTECTED_KEYS[parentKey] : void 0;
		for (const key of issue.keys) {
			if (typeof key !== "string" || !(key in record)) continue;
			if (protectedSet?.has(key)) continue;
			delete record[key];
			removed.push(formatConfigPath([...issuePath, key]));
		}
	}
	return {
		config: next,
		removed
	};
}
function noteOpencodeProviderOverrides(cfg) {
	const providers = cfg.models?.providers;
	if (!providers) return;
	const overrides = [];
	if (providers.opencode) overrides.push("opencode");
	if (providers["opencode-zen"]) overrides.push("opencode-zen");
	if (providers["opencode-go"]) overrides.push("opencode-go");
	if (overrides.length === 0) return;
	const lines = overrides.flatMap((id) => {
		const providerLabel = id === "opencode-go" ? "OpenCode Go" : "OpenCode Zen";
		const providerEntry = providers[id];
		const api = isRecord(providerEntry) && typeof providerEntry.api === "string" ? providerEntry.api : void 0;
		return [`- models.providers.${id} is set; this overrides the built-in ${providerLabel} catalog.`, api ? `- models.providers.${id}.api=${api}` : null].filter((line) => Boolean(line));
	});
	lines.push("- Remove these entries to restore per-model API routing + costs (then re-run setup if needed).");
	note(lines.join("\n"), "OpenCode");
}
function isImplicitFallbackClobber(model) {
	const primary = resolvePrimaryStringValue(model);
	if (typeof model === "string") return primary !== void 0;
	if (model !== null && typeof model === "object" && !Array.isArray(model)) {
		const obj = model;
		return Object.hasOwn(obj, "primary") && !Object.hasOwn(obj, "fallbacks") && primary !== void 0;
	}
	return false;
}
function collectImplicitFallbackClobberWarnings(cfg) {
	const defaultFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
	if (defaultFallbacks.length === 0) return [];
	const warnings = [];
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	for (const [index, agent] of agents.entries()) {
		if (!agent || !isImplicitFallbackClobber(agent.model)) continue;
		const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
		const primary = resolvePrimaryStringValue(agent.model);
		const location = `agents.list[${index}].model (id=${id})`;
		const modelStr = typeof agent.model === "string" ? `"${agent.model}"` : `{ primary: "${primary}" }`;
		const shape = typeof agent.model === "string" ? "bare string with no fallbacks" : "object with no explicit \"fallbacks\" key";
		warnings.push([`- ${location} is ${modelStr}, a ${shape}. At runtime this clobbers agents.defaults.model.fallbacks (${defaultFallbacks.join(", ")}), leaving the agent with no fallbacks.`, `  Fix: add "fallbacks": [...] to inherit or override, or "fallbacks": [] to explicitly disable.`].join("\n"));
	}
	return warnings;
}
function noteImplicitFallbackClobberWarnings(cfg) {
	const warnings = collectImplicitFallbackClobberWarnings(cfg);
	if (warnings.length === 0) return;
	note(warnings.join("\n"), "Doctor warnings");
}
function noteIncludeConfinementWarning(snapshot) {
	const includeIssue = (snapshot.issues ?? []).find((issue) => issue.message.includes("Include path escapes config directory") || issue.message.includes("Include path resolves outside config directory"));
	if (!includeIssue) return;
	note([
		`- $include paths must stay under: ${path.dirname(snapshot.path ?? CONFIG_PATH)}`,
		"- Move shared include files under that directory and update to relative paths like \"./shared/common.json\".",
		`- Error: ${includeIssue.message}`
	].join("\n"), "Doctor warnings");
}
//#endregion
export { resolveConfigPathTarget as a, noteOpencodeProviderOverrides as i, noteImplicitFallbackClobberWarnings as n, stripUnknownConfigKeys as o, noteIncludeConfinementWarning as r, formatConfigPath as t };
