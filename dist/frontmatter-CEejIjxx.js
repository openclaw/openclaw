import { t as createSubsystemLogger } from "./subsystem-2phE7Tdr.js";
import { t as parseBooleanValue } from "./boolean-Cuaw_-7j.js";
import path from "node:path";
import fs from "node:fs";
import JSON5 from "json5";
import YAML from "yaml";
//#region src/hooks/internal-hooks.ts
/**
* Registry of hook handlers by event key.
*
* Uses a globalThis singleton so that registerInternalHook and
* triggerInternalHook always share the same Map even when the bundler
* emits multiple copies of this module into separate chunks (bundle
* splitting). Without the singleton, handlers registered in one chunk
* are invisible to triggerInternalHook in another chunk, causing hooks
* to silently fire with zero handlers.
*/
const _g = globalThis;
const handlers = _g.__openclaw_internal_hook_handlers__ ??= /* @__PURE__ */ new Map();
const log = createSubsystemLogger("internal-hooks");
/**
* Register a hook handler for a specific event type or event:action combination
*
* @param eventKey - Event type (e.g., 'command') or specific action (e.g., 'command:new')
* @param handler - Function to call when the event is triggered
*
* @example
* ```ts
* // Listen to all command events
* registerInternalHook('command', async (event) => {
*   console.log('Command:', event.action);
* });
*
* // Listen only to /new commands
* registerInternalHook('command:new', async (event) => {
*   await saveSessionToMemory(event);
* });
* ```
*/
function registerInternalHook(eventKey, handler) {
	if (!handlers.has(eventKey)) handlers.set(eventKey, []);
	handlers.get(eventKey).push(handler);
}
/**
* Trigger a hook event
*
* Calls all handlers registered for:
* 1. The general event type (e.g., 'command')
* 2. The specific event:action combination (e.g., 'command:new')
*
* Handlers are called in registration order. Errors are caught and logged
* but don't prevent other handlers from running.
*
* @param event - The event to trigger
*/
async function triggerInternalHook(event) {
	const typeHandlers = handlers.get(event.type) ?? [];
	const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
	const allHandlers = [...typeHandlers, ...specificHandlers];
	if (allHandlers.length === 0) return;
	for (const handler of allHandlers) try {
		await handler(event);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error(`Hook error [${event.type}:${event.action}]: ${message}`);
	}
}
/**
* Create a hook event with common fields filled in
*
* @param type - The event type
* @param action - The action within that type
* @param sessionKey - The session key
* @param context - Additional context
*/
function createInternalHookEvent(type, action, sessionKey, context = {}) {
	return {
		type,
		action,
		sessionKey,
		context,
		timestamp: /* @__PURE__ */ new Date(),
		messages: []
	};
}
function isHookEventTypeAndAction(event, type, action) {
	return event.type === type && event.action === action;
}
function getHookContext(event) {
	const context = event.context;
	if (!context || typeof context !== "object") return null;
	return context;
}
function hasStringContextField(context, key) {
	return typeof context[key] === "string";
}
function isAgentBootstrapEvent(event) {
	if (!isHookEventTypeAndAction(event, "agent", "bootstrap")) return false;
	const context = getHookContext(event);
	if (!context) return false;
	if (!hasStringContextField(context, "workspaceDir")) return false;
	return Array.isArray(context.bootstrapFiles);
}
function isGatewayStartupEvent(event) {
	if (!isHookEventTypeAndAction(event, "gateway", "startup")) return false;
	return Boolean(getHookContext(event));
}
//#endregion
//#region src/compat/legacy-names.ts
const PROJECT_NAME = "openclaw";
const LEGACY_PROJECT_NAMES = [];
const MANIFEST_KEY = PROJECT_NAME;
const LEGACY_MANIFEST_KEYS = LEGACY_PROJECT_NAMES;
//#endregion
//#region src/shared/config-eval.ts
function isTruthy(value) {
	if (value === void 0 || value === null) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") return value.trim().length > 0;
	return true;
}
function resolveConfigPath(config, pathStr) {
	const parts = pathStr.split(".").filter(Boolean);
	let current = config;
	for (const part of parts) {
		if (typeof current !== "object" || current === null) return;
		current = current[part];
	}
	return current;
}
function isConfigPathTruthyWithDefaults(config, pathStr, defaults) {
	const value = resolveConfigPath(config, pathStr);
	if (value === void 0 && pathStr in defaults) return defaults[pathStr] ?? false;
	return isTruthy(value);
}
function evaluateRuntimeRequires(params) {
	const requires = params.requires;
	if (!requires) return true;
	const requiredBins = requires.bins ?? [];
	if (requiredBins.length > 0) for (const bin of requiredBins) {
		if (params.hasBin(bin)) continue;
		if (params.hasRemoteBin?.(bin)) continue;
		return false;
	}
	const requiredAnyBins = requires.anyBins ?? [];
	if (requiredAnyBins.length > 0) {
		if (!requiredAnyBins.some((bin) => params.hasBin(bin)) && !params.hasAnyRemoteBin?.(requiredAnyBins)) return false;
	}
	const requiredEnv = requires.env ?? [];
	if (requiredEnv.length > 0) {
		for (const envName of requiredEnv) if (!params.hasEnv(envName)) return false;
	}
	const requiredConfig = requires.config ?? [];
	if (requiredConfig.length > 0) {
		for (const configPath of requiredConfig) if (!params.isConfigPathTruthy(configPath)) return false;
	}
	return true;
}
function evaluateRuntimeEligibility(params) {
	const osList = params.os ?? [];
	const remotePlatforms = params.remotePlatforms ?? [];
	if (osList.length > 0 && !osList.includes(resolveRuntimePlatform()) && !remotePlatforms.some((platform) => osList.includes(platform))) return false;
	if (params.always === true) return true;
	return evaluateRuntimeRequires({
		requires: params.requires,
		hasBin: params.hasBin,
		hasRemoteBin: params.hasRemoteBin,
		hasAnyRemoteBin: params.hasAnyRemoteBin,
		hasEnv: params.hasEnv,
		isConfigPathTruthy: params.isConfigPathTruthy
	});
}
function resolveRuntimePlatform() {
	return process.platform;
}
function windowsPathExtensions() {
	const raw = process.env.PATHEXT;
	return ["", ...(raw !== void 0 ? raw.split(";").map((v) => v.trim()) : [
		".EXE",
		".CMD",
		".BAT",
		".COM"
	]).filter(Boolean)];
}
let cachedHasBinaryPath;
let cachedHasBinaryPathExt;
const hasBinaryCache = /* @__PURE__ */ new Map();
function hasBinary(bin) {
	const pathEnv = process.env.PATH ?? "";
	const pathExt = process.platform === "win32" ? process.env.PATHEXT ?? "" : "";
	if (cachedHasBinaryPath !== pathEnv || cachedHasBinaryPathExt !== pathExt) {
		cachedHasBinaryPath = pathEnv;
		cachedHasBinaryPathExt = pathExt;
		hasBinaryCache.clear();
	}
	if (hasBinaryCache.has(bin)) return hasBinaryCache.get(bin);
	const parts = pathEnv.split(path.delimiter).filter(Boolean);
	const extensions = process.platform === "win32" ? windowsPathExtensions() : [""];
	for (const part of parts) for (const ext of extensions) {
		const candidate = path.join(part, bin + ext);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			hasBinaryCache.set(bin, true);
			return true;
		} catch {}
	}
	hasBinaryCache.set(bin, false);
	return false;
}
//#endregion
//#region src/markdown/frontmatter.ts
function stripQuotes(value) {
	if (value.startsWith("\"") && value.endsWith("\"") || value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
	return value;
}
function coerceYamlFrontmatterValue(value) {
	if (value === null || value === void 0) return;
	if (typeof value === "string") return {
		value: value.trim(),
		kind: "scalar"
	};
	if (typeof value === "number" || typeof value === "boolean") return {
		value: String(value),
		kind: "scalar"
	};
	if (typeof value === "object") try {
		return {
			value: JSON.stringify(value),
			kind: "structured"
		};
	} catch {
		return;
	}
}
function parseYamlFrontmatter(block) {
	try {
		const parsed = YAML.parse(block, { schema: "core" });
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const result = {};
		for (const [rawKey, value] of Object.entries(parsed)) {
			const key = rawKey.trim();
			if (!key) continue;
			const coerced = coerceYamlFrontmatterValue(value);
			if (!coerced) continue;
			result[key] = coerced;
		}
		return result;
	} catch {
		return null;
	}
}
function extractMultiLineValue(lines, startIndex) {
	const valueLines = [];
	let i = startIndex + 1;
	while (i < lines.length) {
		const line = lines[i];
		if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("	")) break;
		valueLines.push(line);
		i += 1;
	}
	return {
		value: valueLines.join("\n").trim(),
		linesConsumed: i - startIndex
	};
}
function parseLineFrontmatter(block) {
	const result = {};
	const lines = block.split("\n");
	let i = 0;
	while (i < lines.length) {
		const match = lines[i].match(/^([\w-]+):\s*(.*)$/);
		if (!match) {
			i += 1;
			continue;
		}
		const key = match[1];
		const inlineValue = match[2].trim();
		if (!key) {
			i += 1;
			continue;
		}
		if (!inlineValue && i + 1 < lines.length) {
			const nextLine = lines[i + 1];
			if (nextLine.startsWith(" ") || nextLine.startsWith("	")) {
				const { value, linesConsumed } = extractMultiLineValue(lines, i);
				if (value) result[key] = {
					value,
					kind: "multiline",
					rawInline: inlineValue
				};
				i += linesConsumed;
				continue;
			}
		}
		const value = stripQuotes(inlineValue);
		if (value) result[key] = {
			value,
			kind: "inline",
			rawInline: inlineValue
		};
		i += 1;
	}
	return result;
}
function lineFrontmatterToPlain(parsed) {
	const result = {};
	for (const [key, entry] of Object.entries(parsed)) result[key] = entry.value;
	return result;
}
function isYamlBlockScalarIndicator(value) {
	return /^[|>][+-]?(\d+)?[+-]?$/.test(value);
}
function shouldPreferInlineLineValue(params) {
	const { lineEntry, yamlValue } = params;
	if (yamlValue.kind !== "structured") return false;
	if (lineEntry.kind !== "inline") return false;
	if (isYamlBlockScalarIndicator(lineEntry.rawInline)) return false;
	return lineEntry.value.includes(":");
}
function extractFrontmatterBlock(content) {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return;
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return;
	return normalized.slice(4, endIndex);
}
function parseFrontmatterBlock(content) {
	const block = extractFrontmatterBlock(content);
	if (!block) return {};
	const lineParsed = parseLineFrontmatter(block);
	const yamlParsed = parseYamlFrontmatter(block);
	if (yamlParsed === null) return lineFrontmatterToPlain(lineParsed);
	const merged = {};
	for (const [key, yamlValue] of Object.entries(yamlParsed)) {
		merged[key] = yamlValue.value;
		const lineEntry = lineParsed[key];
		if (!lineEntry) continue;
		if (shouldPreferInlineLineValue({
			lineEntry,
			yamlValue
		})) merged[key] = lineEntry.value;
	}
	for (const [key, lineEntry] of Object.entries(lineParsed)) if (!(key in merged)) merged[key] = lineEntry.value;
	return merged;
}
//#endregion
//#region src/shared/frontmatter.ts
function normalizeStringList(input) {
	if (!input) return [];
	if (Array.isArray(input)) return input.map((value) => String(value).trim()).filter(Boolean);
	if (typeof input === "string") return input.split(",").map((value) => value.trim()).filter(Boolean);
	return [];
}
function getFrontmatterString(frontmatter, key) {
	const raw = frontmatter[key];
	return typeof raw === "string" ? raw : void 0;
}
function parseFrontmatterBool(value, fallback) {
	const parsed = parseBooleanValue(value);
	return parsed === void 0 ? fallback : parsed;
}
function resolveOpenClawManifestBlock(params) {
	const raw = getFrontmatterString(params.frontmatter, params.key ?? "metadata");
	if (!raw) return;
	try {
		const parsed = JSON5.parse(raw);
		if (!parsed || typeof parsed !== "object") return;
		const manifestKeys = [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS];
		for (const key of manifestKeys) {
			const candidate = parsed[key];
			if (candidate && typeof candidate === "object") return candidate;
		}
		return;
	} catch {
		return;
	}
}
function resolveOpenClawManifestRequires(metadataObj) {
	const requiresRaw = typeof metadataObj.requires === "object" && metadataObj.requires !== null ? metadataObj.requires : void 0;
	if (!requiresRaw) return;
	return {
		bins: normalizeStringList(requiresRaw.bins),
		anyBins: normalizeStringList(requiresRaw.anyBins),
		env: normalizeStringList(requiresRaw.env),
		config: normalizeStringList(requiresRaw.config)
	};
}
function resolveOpenClawManifestInstall(metadataObj, parseInstallSpec) {
	return (Array.isArray(metadataObj.install) ? metadataObj.install : []).map((entry) => parseInstallSpec(entry)).filter((entry) => Boolean(entry));
}
function resolveOpenClawManifestOs(metadataObj) {
	return normalizeStringList(metadataObj.os);
}
function parseOpenClawManifestInstallBase(input, allowedKinds) {
	if (!input || typeof input !== "object") return;
	const raw = input;
	const kind = (typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "").trim().toLowerCase();
	if (!allowedKinds.includes(kind)) return;
	const spec = {
		raw,
		kind
	};
	if (typeof raw.id === "string") spec.id = raw.id;
	if (typeof raw.label === "string") spec.label = raw.label;
	const bins = normalizeStringList(raw.bins);
	if (bins.length > 0) spec.bins = bins;
	return spec;
}
function applyOpenClawManifestInstallCommonFields(spec, parsed) {
	if (parsed.id) spec.id = parsed.id;
	if (parsed.label) spec.label = parsed.label;
	if (parsed.bins) spec.bins = parsed.bins;
	return spec;
}
//#endregion
export { isGatewayStartupEvent as _, parseOpenClawManifestInstallBase as a, resolveOpenClawManifestOs as c, evaluateRuntimeEligibility as d, hasBinary as f, isAgentBootstrapEvent as g, createInternalHookEvent as h, parseFrontmatterBool as i, resolveOpenClawManifestRequires as l, MANIFEST_KEY as m, getFrontmatterString as n, resolveOpenClawManifestBlock as o, isConfigPathTruthyWithDefaults as p, normalizeStringList as r, resolveOpenClawManifestInstall as s, applyOpenClawManifestInstallCommonFields as t, parseFrontmatterBlock as u, registerInternalHook as v, triggerInternalHook as y };
