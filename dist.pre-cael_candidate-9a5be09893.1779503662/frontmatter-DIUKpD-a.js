import { f as readStringValue, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { r as normalizeCsvOrLooseStringList } from "./string-normalization-DiPHgdft.js";
import { n as MANIFEST_KEY, t as LEGACY_MANIFEST_KEYS } from "./legacy-names-CuutNmLC.js";
import JSON5 from "json5";
import YAML from "yaml";
//#region src/utils/boolean.ts
const DEFAULT_TRUTHY = [
	"true",
	"1",
	"yes",
	"on"
];
const DEFAULT_FALSY = [
	"false",
	"0",
	"no",
	"off"
];
const DEFAULT_TRUTHY_SET = new Set(DEFAULT_TRUTHY);
const DEFAULT_FALSY_SET = new Set(DEFAULT_FALSY);
function parseBooleanValue(value, options = {}) {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return;
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return;
	const truthy = options.truthy ?? DEFAULT_TRUTHY;
	const falsy = options.falsy ?? DEFAULT_FALSY;
	const truthySet = truthy === DEFAULT_TRUTHY ? DEFAULT_TRUTHY_SET : new Set(truthy);
	const falsySet = falsy === DEFAULT_FALSY ? DEFAULT_FALSY_SET : new Set(falsy);
	if (truthySet.has(normalized)) return true;
	if (falsySet.has(normalized)) return false;
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
	return normalizeCsvOrLooseStringList(input);
}
function getFrontmatterString(frontmatter, key) {
	return readStringValue(frontmatter[key]);
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
	const kind = normalizeOptionalLowercaseString(typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "") ?? "";
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
export { parseOpenClawManifestInstallBase as a, resolveOpenClawManifestOs as c, parseBooleanValue as d, parseFrontmatterBool as i, resolveOpenClawManifestRequires as l, getFrontmatterString as n, resolveOpenClawManifestBlock as o, normalizeStringList as r, resolveOpenClawManifestInstall as s, applyOpenClawManifestInstallCommonFields as t, parseFrontmatterBlock as u };
