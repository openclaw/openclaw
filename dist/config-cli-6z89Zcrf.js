import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { t as CONFIG_PATH } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { l as isValidEnvSecretRefId, m as resolveSecretInputRef, o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAgentModelRefForConfig, t as normalizeAgentModelMapForConfig } from "./model-input-ChW9XXsQ.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { n as discoverConfigSecretTargets, s as resolveConfigSecretTargetByPath } from "./target-registry-t5xykQQS.js";
import { a as formatExecSecretRefIdValidationMessage, c as isValidSecretProviderAlias, d as validateExecSecretRefId, o as isValidExecSecretRefId, s as isValidFileSecretRefId, u as secretRefKey } from "./ref-contract-D_h_G00C.js";
import { a as resolveSecretRefValue } from "./resolve-D1Ko6pWx.js";
import { n as info, o as success, t as danger } from "./globals-YU5FjfZK.js";
import { U as AUTO_MANAGED_CONFIG_META_PATHS, u as readConfigFileSnapshot, w as validateConfigObjectRawWithPlugins, x as collectUnsupportedSecretRefPolicyIssues } from "./io-DoswVvYe.js";
import { n as formatConfigIssueLines, o as normalizeConfigIssues } from "./issue-format-c8ezaSew.js";
import { r as normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared-BkjJfDrJ.js";
import { w as SecretProviderSchema } from "./zod-schema.core-D7Y_eqdd.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { s as formatStrictJsonParseFailure } from "./error-format-BfFDdqsq.js";
import { n as redactConfigObject } from "./redact-snapshot-DLK0iGBB.js";
import { n as readBestEffortRuntimeConfigSchema } from "./runtime-schema-pPVn7_7T.js";
import { n as setCommandJsonMode } from "./json-mode-CV8Xwki5.js";
import fs from "node:fs";
import JSON5 from "json5";
//#region src/cli/config-set-input.ts
function hasBatchMode(opts) {
	return Boolean(normalizeOptionalString(opts.batchJson) || normalizeOptionalString(opts.batchFile));
}
function hasRefBuilderOptions(opts) {
	return Boolean(opts.refProvider || opts.refSource || opts.refId);
}
function hasProviderBuilderOptions(opts) {
	return Boolean(opts.providerSource || opts.providerAllowlist?.length || opts.providerPath || opts.providerMode || opts.providerTimeoutMs || opts.providerMaxBytes || opts.providerCommand || opts.providerArg?.length || opts.providerNoOutputTimeoutMs || opts.providerMaxOutputBytes || opts.providerJsonOnly || opts.providerEnv?.length || opts.providerPassEnv?.length || opts.providerTrustedDir?.length || opts.providerAllowInsecurePath || opts.providerAllowSymlinkCommand);
}
function parseJson5Raw(raw, label) {
	try {
		return JSON5.parse(raw);
	} catch (err) {
		throw new Error(`Failed to parse ${label}: ${String(err)}`, { cause: err });
	}
}
function parseBatchEntries(raw, sourceLabel) {
	const parsed = parseJson5Raw(raw, sourceLabel);
	if (!Array.isArray(parsed)) throw new Error(`${sourceLabel} must be a JSON array.`);
	const out = [];
	for (const [index, entry] of parsed.entries()) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${sourceLabel}[${index}] must be an object.`);
		const typed = entry;
		const path = normalizeOptionalString(typed.path) ?? "";
		if (!path) throw new Error(`${sourceLabel}[${index}].path is required.`);
		const hasValue = Object.prototype.hasOwnProperty.call(typed, "value");
		const hasRef = Object.prototype.hasOwnProperty.call(typed, "ref");
		const hasProvider = Object.prototype.hasOwnProperty.call(typed, "provider");
		if (Number(hasValue) + Number(hasRef) + Number(hasProvider) !== 1) throw new Error(`${sourceLabel}[${index}] must include exactly one of: value, ref, provider.`);
		out.push({
			path,
			...hasValue ? { value: typed.value } : {},
			...hasRef ? { ref: typed.ref } : {},
			...hasProvider ? { provider: typed.provider } : {}
		});
	}
	return out;
}
function parseBatchSource(opts) {
	const batchJson = normalizeOptionalString(opts.batchJson);
	const batchFile = normalizeOptionalString(opts.batchFile);
	const hasInline = Boolean(batchJson);
	const hasFile = Boolean(batchFile);
	if (!hasInline && !hasFile) return null;
	if (hasInline && hasFile) throw new Error("Use either --batch-json or --batch-file, not both.");
	if (hasInline) return parseBatchEntries(batchJson, "--batch-json");
	const pathname = normalizeStringifiedOptionalString(opts.batchFile) ?? "";
	if (!pathname) throw new Error("--batch-file must not be empty.");
	return parseBatchEntries(fs.readFileSync(pathname, "utf8"), "--batch-file");
}
//#endregion
//#region src/cli/config-set-parser.ts
function resolveConfigSetMode(params) {
	if (params.hasBatchMode) {
		if (params.hasRefBuilderOptions || params.hasProviderBuilderOptions) return {
			ok: false,
			error: "batch mode (--batch-json/--batch-file) cannot be combined with ref builder (--ref-*) or provider builder (--provider-*) flags."
		};
		return {
			ok: true,
			mode: "batch"
		};
	}
	if (params.hasRefBuilderOptions && params.hasProviderBuilderOptions) return {
		ok: false,
		error: "choose exactly one mode: ref builder (--ref-provider/--ref-source/--ref-id) or provider builder (--provider-*), not both."
	};
	if (params.hasRefBuilderOptions) return {
		ok: true,
		mode: "ref_builder"
	};
	if (params.hasProviderBuilderOptions) return {
		ok: true,
		mode: "provider_builder"
	};
	return {
		ok: true,
		mode: params.strictJson ? "json" : "value"
	};
}
//#endregion
//#region src/cli/config-cli.ts
function normalizeAgentDefaultModelValueForConfigMutation(value) {
	if (typeof value === "string") return normalizeAgentModelRefForConfig(value);
	if (!isPlainRecord(value)) return value;
	const next = { ...value };
	if (typeof next.primary === "string") next.primary = normalizeAgentModelRefForConfig(next.primary);
	if (Array.isArray(next.fallbacks)) next.fallbacks = next.fallbacks.map((fallback) => typeof fallback === "string" ? normalizeAgentModelRefForConfig(fallback) : fallback);
	return next;
}
function normalizeAgentListModelRefsForConfigMutation(value) {
	if (!Array.isArray(value)) return value;
	let mutated = false;
	const next = value.map((agent) => {
		if (!isPlainRecord(agent)) return agent;
		let nextAgent = agent;
		if (Object.prototype.hasOwnProperty.call(agent, "model")) {
			const model = normalizeAgentDefaultModelValueForConfigMutation(agent.model);
			if (model !== agent.model) {
				nextAgent = {
					...nextAgent,
					model
				};
				mutated = true;
			}
		}
		if (isPlainRecord(agent.models)) {
			const models = normalizeAgentModelMapForConfig(agent.models);
			if (models !== agent.models) {
				nextAgent = {
					...nextAgent,
					models
				};
				mutated = true;
			}
		}
		return nextAgent;
	});
	return mutated ? next : value;
}
function normalizeProviderCatalogModelsForConfigMutation(provider, models) {
	if (!Array.isArray(models)) return models;
	let mutated = false;
	const next = models.map((model) => {
		if (!isPlainRecord(model) || typeof model.id !== "string") return model;
		const trimmed = model.id.trim();
		if (!trimmed) return model;
		const id = normalizeConfiguredProviderCatalogModelId(provider, trimmed);
		if (id === model.id) return model;
		mutated = true;
		return {
			...model,
			id
		};
	});
	return mutated ? next : models;
}
function normalizeModelProviderRefsForConfigMutation(providers) {
	if (!isPlainRecord(providers)) return providers;
	let mutated = false;
	const nextProviders = { ...providers };
	for (const [provider, providerConfig] of Object.entries(providers)) {
		if (!isPlainRecord(providerConfig)) continue;
		const models = normalizeProviderCatalogModelsForConfigMutation(provider, providerConfig.models);
		if (models === providerConfig.models) continue;
		nextProviders[provider] = {
			...providerConfig,
			models
		};
		mutated = true;
	}
	return mutated ? nextProviders : providers;
}
function normalizeConfigMutationModelRefs(cfg) {
	const defaults = cfg.agents?.defaults;
	const agentList = cfg.agents?.list;
	const providers = cfg.models?.providers;
	const normalizedAgentList = normalizeAgentListModelRefsForConfigMutation(agentList);
	const normalizedProviders = normalizeModelProviderRefsForConfigMutation(providers);
	return {
		...cfg,
		...defaults || normalizedAgentList !== agentList ? { agents: {
			...cfg.agents,
			...defaults ? { defaults: {
				...defaults,
				...defaults.model !== void 0 ? { model: normalizeAgentDefaultModelValueForConfigMutation(defaults.model) } : void 0,
				...defaults.models !== void 0 ? { models: normalizeAgentModelMapForConfig(defaults.models) } : void 0
			} } : void 0,
			...normalizedAgentList !== agentList ? { list: normalizedAgentList } : void 0
		} } : void 0,
		...normalizedProviders !== providers ? { models: {
			...cfg.models,
			providers: normalizedProviders
		} } : void 0
	};
}
function normalizeConfigMutationExplicitSetPath(path) {
	if (path.length >= 4 && path[0] === "agents" && path[1] === "defaults" && path[2] === "models") {
		const normalizedModelId = normalizeAgentModelRefForConfig(path[3]);
		return normalizedModelId === path[3] ? path : [
			...path.slice(0, 3),
			normalizedModelId,
			...path.slice(4)
		];
	}
	return path;
}
const GATEWAY_AUTH_MODE_PATH = [
	"gateway",
	"auth",
	"mode"
];
const SECRET_PROVIDER_PATH_PREFIX = ["secrets", "providers"];
const PLUGIN_INSTALL_RECORD_PATH_PREFIX = ["plugins", "installs"];
const CONFIG_SET_EXAMPLE_VALUE = formatCliCommand("openclaw config set gateway.port 19001 --strict-json");
const CONFIG_SET_EXAMPLE_REF = formatCliCommand("openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN");
const CONFIG_SET_EXAMPLE_PROVIDER = formatCliCommand("openclaw config set secrets.providers.vault --provider-source file --provider-path /etc/openclaw/secrets.json --provider-mode json");
const CONFIG_SET_EXAMPLE_BATCH = formatCliCommand("openclaw config set --batch-file ./config-set.batch.json --dry-run");
const CONFIG_PATCH_EXAMPLE_FILE = formatCliCommand("openclaw config patch --file ./openclaw.patch.json5 --dry-run");
const CONFIG_PATCH_EXAMPLE_STDIN = formatCliCommand("openclaw config patch --stdin");
const CONFIG_SET_DESCRIPTION = [
	"Set config values by path (value mode, ref/provider builder mode, or batch JSON mode).",
	"Examples:",
	CONFIG_SET_EXAMPLE_VALUE,
	CONFIG_SET_EXAMPLE_REF,
	CONFIG_SET_EXAMPLE_PROVIDER,
	CONFIG_SET_EXAMPLE_BATCH
].join("\n");
const CONFIG_PATCH_DESCRIPTION = [
	"Patch config from a JSON5 object in one validated write.",
	"Objects merge recursively, arrays/scalars replace, and null deletes a path.",
	"Examples:",
	CONFIG_PATCH_EXAMPLE_FILE,
	CONFIG_PATCH_EXAMPLE_STDIN
].join("\n");
const CONFIG_SET_POLICY_ERROR_MAX_ISSUES = 5;
const CONFIG_PATCH_STDIN_MAX_BYTES = 1024 * 1024;
var ConfigSetDryRunValidationError = class extends Error {
	constructor(result) {
		super("config set dry-run validation failed");
		this.result = result;
		this.name = "ConfigSetDryRunValidationError";
	}
};
function isIndexSegment(raw) {
	return /^[0-9]+$/.test(raw);
}
function parseBracketPathSegment(raw, fullPath) {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error(`Invalid path (empty "[]"): ${fullPath}`);
	if (trimmed.startsWith("\"") || trimmed.startsWith("'")) {
		try {
			const parsed = JSON5.parse(trimmed);
			if (typeof parsed === "string" && parsed.trim()) return parsed;
		} catch (err) {
			throw new Error(`Invalid path bracket string (${trimmed}): ${fullPath}`, { cause: err });
		}
		throw new Error(`Invalid path bracket string (${trimmed}): ${fullPath}`);
	}
	return trimmed;
}
function parsePath(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	const parts = [];
	let current = "";
	let i = 0;
	while (i < trimmed.length) {
		const ch = trimmed[i];
		if (ch === "\\") {
			const next = trimmed[i + 1];
			if (next) current += next;
			i += 2;
			continue;
		}
		if (ch === ".") {
			if (current) parts.push(current);
			current = "";
			i += 1;
			continue;
		}
		if (ch === "[") {
			if (current) parts.push(current);
			current = "";
			const close = trimmed.indexOf("]", i);
			if (close === -1) throw new Error(`Invalid path (missing "]"): ${raw}`);
			const inside = trimmed.slice(i + 1, close).trim();
			if (!inside) throw new Error(`Invalid path (empty "[]"): ${raw}`);
			parts.push(parseBracketPathSegment(inside, raw));
			i = close + 1;
			continue;
		}
		current += ch;
		i += 1;
	}
	if (current) parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}
function parseValue(raw, opts) {
	const trimmed = raw.trim();
	if (opts.strictJson) try {
		return JSON.parse(trimmed);
	} catch (err) {
		throw new Error(formatStrictJsonParseFailure({
			value: raw,
			cause: err
		}), { cause: err });
	}
	try {
		return JSON5.parse(trimmed);
	} catch {
		return raw;
	}
}
function hasOwnPathKey(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}
function isPlainRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function formatDoctorHint(message) {
	return `Run \`${formatCliCommand("openclaw doctor --fix")}\` ${message}`;
}
function formatUnsupportedSecretRefPolicyFailureMessage(issues) {
	const lines = ["Config policy validation failed: unsupported SecretRef usage was detected.", ...issues.slice(0, CONFIG_SET_POLICY_ERROR_MAX_ISSUES).map((issue) => `- ${issue}`)];
	if (issues.length > CONFIG_SET_POLICY_ERROR_MAX_ISSUES) lines.push(`- ... ${issues.length - CONFIG_SET_POLICY_ERROR_MAX_ISSUES} more`);
	return lines.join("\n");
}
function validatePathSegments(path) {
	for (const segment of path) if (!isIndexSegment(segment) && isBlockedObjectKey(segment)) throw new Error(`Invalid path segment: ${segment}`);
}
function getAtPath(root, path) {
	let current = root;
	for (const segment of path) {
		if (!current || typeof current !== "object") return { found: false };
		if (Array.isArray(current)) {
			if (!isIndexSegment(segment)) return { found: false };
			const index = Number.parseInt(segment, 10);
			if (!Number.isFinite(index) || index < 0 || index >= current.length) return { found: false };
			current = current[index];
			continue;
		}
		const record = current;
		if (!hasOwnPathKey(record, segment)) return { found: false };
		current = record[segment];
	}
	return {
		found: true,
		value: current
	};
}
function isSchemaRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function schemaTypes(schema) {
	if (typeof schema.type === "string") return new Set([schema.type]);
	if (Array.isArray(schema.type)) return new Set(schema.type.filter((entry) => typeof entry === "string"));
	return /* @__PURE__ */ new Set();
}
function schemaAlternatives(schema, seen = /* @__PURE__ */ new Set()) {
	if (seen.has(schema)) return [];
	seen.add(schema);
	const alternatives = [schema];
	for (const key of [
		"anyOf",
		"oneOf",
		"allOf"
	]) {
		const entries = schema[key];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) if (isSchemaRecord(entry)) alternatives.push(...schemaAlternatives(entry, seen));
	}
	return alternatives;
}
function schemaLooksArray(schema) {
	return schemaTypes(schema).has("array") || isSchemaRecord(schema.items) || Array.isArray(schema.items);
}
function schemaLooksObject(schema) {
	return schemaTypes(schema).has("object") || isSchemaRecord(schema.properties) || schema.additionalProperties === true || isSchemaRecord(schema.additionalProperties);
}
function propertySchema(schema, segment) {
	const schemas = [];
	for (const alternative of schemaAlternatives(schema)) {
		if (schemaLooksArray(alternative)) {
			if (isIndexSegment(segment)) {
				const index = Number.parseInt(segment, 10);
				const indexedItem = Array.isArray(alternative.items) ? alternative.items[index] : alternative.items;
				if (isSchemaRecord(indexedItem)) schemas.push(indexedItem);
			}
			continue;
		}
		const explicit = (isSchemaRecord(alternative.properties) ? alternative.properties : void 0)?.[segment];
		if (isSchemaRecord(explicit)) {
			schemas.push(explicit);
			continue;
		}
		if (isSchemaRecord(alternative.additionalProperties)) schemas.push(alternative.additionalProperties);
	}
	return schemas;
}
function schemasAtPath(schema, path) {
	if (!schema) return [];
	let schemas = [schema];
	for (const segment of path) {
		schemas = schemas.flatMap((candidate) => propertySchema(candidate, segment));
		if (schemas.length === 0) return [];
	}
	return schemas;
}
function schemaPrefersArrayAtPath(schema, path) {
	const candidates = schemasAtPath(schema, path).flatMap((candidate) => schemaAlternatives(candidate));
	if (candidates.length === 0) return;
	const hasArray = candidates.some((candidate) => schemaLooksArray(candidate));
	const hasObject = candidates.some((candidate) => schemaLooksObject(candidate));
	if (hasArray && !hasObject) return true;
	if (hasObject && !hasArray) return false;
}
function shouldCreateArrayForMissingPathSegment(params) {
	if (!params.next || params.options?.numericObjectKeys || !isIndexSegment(params.next)) return false;
	const parentPath = params.path.slice(0, params.segmentIndex + 1);
	const schemaPreference = schemaPrefersArrayAtPath(params.options?.schema, parentPath);
	if (schemaPreference !== void 0) return schemaPreference;
	return true;
}
function setAtPath(root, path, value, options) {
	let current = root;
	for (let i = 0; i < path.length - 1; i += 1) {
		const segment = path[i];
		const next = path[i + 1];
		const nextIsIndex = shouldCreateArrayForMissingPathSegment({
			path,
			segmentIndex: i,
			next,
			options
		});
		if (Array.isArray(current)) {
			if (!isIndexSegment(segment)) throw new Error(`Expected numeric index for array segment "${segment}"`);
			const index = Number.parseInt(segment, 10);
			const existing = current[index];
			if (!existing || typeof existing !== "object") current[index] = nextIsIndex ? [] : {};
			current = current[index];
			continue;
		}
		if (!current || typeof current !== "object") throw new Error(`Cannot traverse into "${segment}" (not an object)`);
		const record = current;
		const existing = hasOwnPathKey(record, segment) ? record[segment] : void 0;
		if (!existing || typeof existing !== "object") record[segment] = nextIsIndex ? [] : {};
		current = record[segment];
	}
	const last = path[path.length - 1];
	if (Array.isArray(current)) {
		if (!isIndexSegment(last)) throw new Error(`Expected numeric index for array segment "${last}"`);
		const index = Number.parseInt(last, 10);
		current[index] = value;
		return;
	}
	if (!current || typeof current !== "object") throw new Error(`Cannot set "${last}" (parent is not an object)`);
	current[last] = value;
}
function modelArrayIds(value) {
	if (!Array.isArray(value)) return null;
	const ids = /* @__PURE__ */ new Set();
	for (const entry of value) {
		if (!isPlainRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) return null;
		ids.add(entry.id.trim());
	}
	return ids;
}
function mergeModelArrays(existing, patch) {
	const merged = [...existing];
	const indexById = /* @__PURE__ */ new Map();
	for (const [index, entry] of merged.entries()) if (isPlainRecord(entry) && typeof entry.id === "string" && entry.id.trim()) indexById.set(entry.id.trim(), index);
	for (const entry of patch) {
		if (!isPlainRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
			merged.push(entry);
			continue;
		}
		const id = entry.id.trim();
		const existingIndex = indexById.get(id);
		if (existingIndex === void 0) {
			indexById.set(id, merged.length);
			merged.push(entry);
			continue;
		}
		const existingEntry = merged[existingIndex];
		merged[existingIndex] = isPlainRecord(existingEntry) ? {
			...existingEntry,
			...entry
		} : entry;
	}
	return merged;
}
function mergeConfigValue(existing, patch, path) {
	if (isProviderModelListPath(path) && Array.isArray(existing) && Array.isArray(patch)) return mergeModelArrays(existing, patch);
	if (isPlainRecord(existing) && isPlainRecord(patch)) {
		const next = { ...existing };
		for (const [key, value] of Object.entries(patch)) next[key] = hasOwnPathKey(next, key) && isPlainRecord(next[key]) && isPlainRecord(value) ? mergeConfigValue(next[key], value, [...path, key]) : value;
		return next;
	}
	throw new Error(`Cannot merge ${toDotPath(path)}; use --replace to replace intentionally.`);
}
function mergeAtPath(root, path, value, options) {
	const existing = getAtPath(root, path);
	if (!existing.found) {
		setAtPath(root, path, value, options);
		return;
	}
	setAtPath(root, path, mergeConfigValue(existing.value, value, path), options);
}
function isProviderModelListPath(path) {
	return path.length === 4 && path[0] === "models" && path[1] === "providers" && path[3] === "models";
}
function isProtectedMapReplacementPath(path) {
	if (path.join(".") === "agents.defaults.models") return true;
	if (path.join(".") === "models.providers") return true;
	if (path.length === 3 && path[0] === "models" && path[1] === "providers") return true;
	if (path.join(".") === "plugins.entries") return true;
	if (path.join(".") === "auth.profiles") return true;
	return false;
}
function isProtectedArrayReplacementPath(path) {
	return isProviderModelListPath(path) || path.join(".") === "agents.list";
}
function formatRemovedEntries(entries) {
	const visible = entries.slice(0, 6);
	const suffix = entries.length > visible.length ? `, ... ${entries.length - visible.length} more` : "";
	return `${visible.join(", ")}${suffix}`;
}
function assertNonDestructiveReplacement(params) {
	if (params.allowReplace) return;
	const existing = getAtPath(params.root, params.path);
	if (!existing.found) return;
	const pathLabel = toDotPath(params.path);
	if (isProtectedMapReplacementPath(params.path) && isPlainRecord(existing.value)) {
		if (!isPlainRecord(params.value)) return;
		const nextKeys = new Set(Object.keys(params.value));
		const removed = Object.keys(existing.value).filter((key) => !nextKeys.has(key));
		if (removed.length > 0) throw new Error(`Refusing to replace ${pathLabel}; it would remove existing entries: ${formatRemovedEntries(removed)}. Use --merge to merge object values or --replace to replace intentionally.`);
	}
	if (isProtectedArrayReplacementPath(params.path)) {
		const existingIds = modelArrayIds(existing.value);
		const nextIds = modelArrayIds(params.value);
		if (!existingIds || !nextIds) return;
		const removed = [...existingIds].filter((id) => !nextIds.has(id));
		if (removed.length > 0) throw new Error(`Refusing to replace ${pathLabel}; it would remove existing entries: ${formatRemovedEntries(removed)}. Use --merge to merge by id or --replace to replace intentionally.`);
	}
}
function unsetAtPath(root, path) {
	let current = root;
	for (let i = 0; i < path.length - 1; i += 1) {
		const segment = path[i];
		if (!current || typeof current !== "object") return { removed: false };
		if (Array.isArray(current)) {
			if (!isIndexSegment(segment)) return { removed: false };
			const index = Number.parseInt(segment, 10);
			if (!Number.isFinite(index) || index < 0 || index >= current.length) return { removed: false };
			current = current[index];
			continue;
		}
		const record = current;
		if (!hasOwnPathKey(record, segment)) return { removed: false };
		current = record[segment];
	}
	const last = path[path.length - 1];
	if (Array.isArray(current)) {
		if (!isIndexSegment(last)) return { removed: false };
		const index = Number.parseInt(last, 10);
		if (!Number.isFinite(index) || index < 0 || index >= current.length) return { removed: false };
		current.splice(index, 1);
		return {
			removed: true,
			leafContainer: "array"
		};
	}
	if (!current || typeof current !== "object") return { removed: false };
	const record = current;
	if (!hasOwnPathKey(record, last)) return { removed: false };
	delete record[last];
	return {
		removed: true,
		leafContainer: "object"
	};
}
async function loadValidConfig(runtime = defaultRuntime) {
	const snapshot = await readConfigFileSnapshot();
	if (snapshot.valid) return snapshot;
	runtime.error(`OpenClaw config is invalid: ${shortenHomePath(snapshot.path)}`);
	for (const line of formatConfigIssueLines(snapshot.issues, "-", { normalizeRoot: true })) runtime.error(line);
	runtime.error(formatDoctorHint("to repair, then retry."));
	runtime.exit(1);
	return snapshot;
}
function parseRequiredPath(path) {
	const parsedPath = parsePath(path);
	if (parsedPath.length === 0) throw new Error("Path is empty.");
	validatePathSegments(parsedPath);
	return parsedPath;
}
function pathEquals(path, expected) {
	return path.length === expected.length && path.every((segment, index) => segment === expected[index]);
}
function pruneInactiveGatewayAuthCredentials(params) {
	if (!params.operations.some((operation) => pathEquals(operation.requestedPath, GATEWAY_AUTH_MODE_PATH))) return [];
	const gatewayRaw = params.root.gateway;
	if (!gatewayRaw || typeof gatewayRaw !== "object" || Array.isArray(gatewayRaw)) return [];
	const authRaw = gatewayRaw.auth;
	if (!authRaw || typeof authRaw !== "object" || Array.isArray(authRaw)) return [];
	const auth = authRaw;
	const mode = normalizeOptionalString(auth.mode) ?? "";
	const removedPaths = [];
	const remove = (key) => {
		if (Object.hasOwn(auth, key)) {
			delete auth[key];
			removedPaths.push(`gateway.auth.${key}`);
		}
	};
	if (mode === "token") remove("password");
	else if (mode === "password") remove("token");
	else if (mode === "trusted-proxy") {
		remove("token");
		remove("password");
	}
	return removedPaths;
}
function toDotPath(path) {
	return path.join(".");
}
function parseSecretRefSource(raw, label) {
	const source = raw.trim();
	if (source === "env" || source === "file" || source === "exec") return source;
	throw new Error(`${label} must be one of: env, file, exec.`);
}
function parseSecretRefBuilder(params) {
	const provider = params.provider.trim();
	if (!provider) throw new Error(`${params.fieldPrefix}.provider is required.`);
	if (!isValidSecretProviderAlias(provider)) throw new Error(`${params.fieldPrefix}.provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").`);
	const source = parseSecretRefSource(params.source, `${params.fieldPrefix}.source`);
	const id = params.id.trim();
	if (!id) throw new Error(`${params.fieldPrefix}.id is required.`);
	if (source === "env" && !isValidEnvSecretRefId(id)) throw new Error(`${params.fieldPrefix}.id must match /^[A-Z][A-Z0-9_]{0,127}$/ for env refs.`);
	if (source === "file" && !isValidFileSecretRefId(id)) throw new Error(`${params.fieldPrefix}.id must be an absolute JSON pointer (or "value" for singleValue mode).`);
	if (source === "exec") {
		if (!validateExecSecretRefId(id).ok) throw new Error(formatExecSecretRefIdValidationMessage());
	}
	return {
		source,
		provider,
		id
	};
}
function parseOptionalPositiveInteger(raw, flag) {
	if (raw === void 0) return;
	const trimmed = raw.trim();
	if (!trimmed) throw new Error(`${flag} must not be empty.`);
	const parsed = Number(trimmed);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`);
	return parsed;
}
function parseProviderEnvEntries(entries) {
	if (!entries || entries.length === 0) return;
	const env = {};
	for (const entry of entries) {
		const separator = entry.indexOf("=");
		if (separator <= 0) throw new Error(`--provider-env expects KEY=VALUE entries (received: "${entry}").`);
		const key = entry.slice(0, separator).trim();
		if (!key) throw new Error(`--provider-env key must not be empty (received: "${entry}").`);
		env[key] = entry.slice(separator + 1);
	}
	return Object.keys(env).length > 0 ? env : void 0;
}
function parseProviderAliasPath(path) {
	if (!(path.length === 3 && path[0] === SECRET_PROVIDER_PATH_PREFIX[0] && path[1] === SECRET_PROVIDER_PATH_PREFIX[1])) throw new Error("Provider builder mode requires path \"secrets.providers.<alias>\" (example: secrets.providers.vault).");
	const alias = path[2] ?? "";
	if (!isValidSecretProviderAlias(alias)) throw new Error(`Provider alias "${alias}" must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").`);
	return alias;
}
function buildProviderFromBuilder(opts) {
	const sourceRaw = opts.providerSource?.trim();
	if (!sourceRaw) throw new Error("--provider-source is required in provider builder mode.");
	const source = parseSecretRefSource(sourceRaw, "--provider-source");
	const timeoutMs = parseOptionalPositiveInteger(opts.providerTimeoutMs, "--provider-timeout-ms");
	const maxBytes = parseOptionalPositiveInteger(opts.providerMaxBytes, "--provider-max-bytes");
	const noOutputTimeoutMs = parseOptionalPositiveInteger(opts.providerNoOutputTimeoutMs, "--provider-no-output-timeout-ms");
	const maxOutputBytes = parseOptionalPositiveInteger(opts.providerMaxOutputBytes, "--provider-max-output-bytes");
	const providerEnv = parseProviderEnvEntries(opts.providerEnv);
	let provider;
	if (source === "env") {
		const allowlist = (opts.providerAllowlist ?? []).map((entry) => entry.trim()).filter(Boolean);
		for (const envName of allowlist) if (!isValidEnvSecretRefId(envName)) throw new Error(`--provider-allowlist entry "${envName}" must match /^[A-Z][A-Z0-9_]{0,127}$/.`);
		provider = {
			source: "env",
			...allowlist.length > 0 ? { allowlist } : {}
		};
	} else if (source === "file") {
		const filePath = opts.providerPath?.trim();
		if (!filePath) throw new Error("--provider-path is required when --provider-source file is used.");
		const modeRaw = opts.providerMode?.trim();
		if (modeRaw && modeRaw !== "singleValue" && modeRaw !== "json") throw new Error("--provider-mode must be one of: singleValue, json.");
		const mode = modeRaw === "singleValue" || modeRaw === "json" ? modeRaw : void 0;
		provider = {
			source: "file",
			path: filePath,
			...mode ? { mode } : {},
			...timeoutMs !== void 0 ? { timeoutMs } : {},
			...maxBytes !== void 0 ? { maxBytes } : {},
			...opts.providerAllowInsecurePath ? { allowInsecurePath: true } : {}
		};
	} else {
		const command = opts.providerCommand?.trim();
		if (!command) throw new Error("--provider-command is required when --provider-source exec is used.");
		provider = {
			source: "exec",
			command,
			...opts.providerArg && opts.providerArg.length > 0 ? { args: opts.providerArg.map((entry) => entry.trim()) } : {},
			...timeoutMs !== void 0 ? { timeoutMs } : {},
			...noOutputTimeoutMs !== void 0 ? { noOutputTimeoutMs } : {},
			...maxOutputBytes !== void 0 ? { maxOutputBytes } : {},
			...opts.providerJsonOnly ? { jsonOnly: true } : {},
			...providerEnv ? { env: providerEnv } : {},
			...opts.providerPassEnv && opts.providerPassEnv.length > 0 ? { passEnv: opts.providerPassEnv.map((entry) => entry.trim()).filter(Boolean) } : {},
			...opts.providerTrustedDir && opts.providerTrustedDir.length > 0 ? { trustedDirs: opts.providerTrustedDir.map((entry) => entry.trim()).filter(Boolean) } : {},
			...opts.providerAllowInsecurePath ? { allowInsecurePath: true } : {},
			...opts.providerAllowSymlinkCommand ? { allowSymlinkCommand: true } : {}
		};
	}
	const validated = SecretProviderSchema.safeParse(provider);
	if (!validated.success) {
		const issue = validated.error.issues[0];
		const issuePath = issue?.path?.join(".") ?? "<provider>";
		const issueMessage = issue?.message ?? "Invalid provider config.";
		throw new Error(`Provider builder config invalid at ${issuePath}: ${issueMessage}`);
	}
	return validated.data;
}
function parseSecretRefFromUnknown(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object with source/provider/id.`);
	const candidate = value;
	if (typeof candidate.provider !== "string" || typeof candidate.source !== "string" || typeof candidate.id !== "string") throw new Error(`${label} must include string fields: source, provider, id.`);
	return parseSecretRefBuilder({
		provider: candidate.provider,
		source: candidate.source,
		id: candidate.id,
		fieldPrefix: label
	});
}
function buildRefAssignmentOperation(params) {
	const resolved = resolveConfigSecretTargetByPath(params.requestedPath);
	if (resolved?.entry.secretShape === "sibling_ref" && resolved.refPathSegments) return {
		inputMode: params.inputMode,
		requestedPath: params.requestedPath,
		setPath: resolved.refPathSegments,
		value: params.ref,
		schemaValidated: true,
		touchedSecretTargetPath: toDotPath(resolved.pathSegments),
		assignedRef: params.ref,
		...resolved.providerId ? { touchedProviderAlias: resolved.providerId } : {}
	};
	return {
		inputMode: params.inputMode,
		requestedPath: params.requestedPath,
		setPath: params.requestedPath,
		value: params.ref,
		...resolved ? { schemaValidated: true } : {},
		touchedSecretTargetPath: resolved ? toDotPath(resolved.pathSegments) : toDotPath(params.requestedPath),
		assignedRef: params.ref,
		...resolved?.providerId ? { touchedProviderAlias: resolved.providerId } : {}
	};
}
function parseProviderAliasFromTargetPath(path) {
	if (path.length >= 3 && path[0] === SECRET_PROVIDER_PATH_PREFIX[0] && path[1] === SECRET_PROVIDER_PATH_PREFIX[1]) return path[2] ?? null;
	return null;
}
function touchesSecretProviderCollection(path) {
	return path.length === 1 && path[0] === "secrets" || path.length === 2 && path[0] === "secrets" && path[1] === "providers";
}
function touchesSecretDefaults(path) {
	return path.length === 1 && path[0] === "secrets" || path.length === 2 && path[0] === "secrets" && path[1] === "defaults";
}
function buildValueAssignmentOperation(params) {
	const resolved = resolveConfigSecretTargetByPath(params.requestedPath);
	const providerAlias = parseProviderAliasFromTargetPath(params.requestedPath);
	const coercedRef = coerceSecretRef(params.value);
	return {
		inputMode: params.inputMode,
		requestedPath: params.requestedPath,
		setPath: params.requestedPath,
		value: params.value,
		...resolved ? { touchedSecretTargetPath: toDotPath(resolved.pathSegments) } : {},
		...providerAlias ? { touchedProviderAlias: providerAlias } : {},
		...coercedRef ? { assignedRef: coercedRef } : {}
	};
}
function parseBatchOperations(entries) {
	const operations = [];
	for (const [index, entry] of entries.entries()) {
		const path = parseRequiredPath(entry.path);
		if (entry.ref !== void 0) {
			const ref = parseSecretRefFromUnknown(entry.ref, `batch[${index}].ref`);
			operations.push(buildRefAssignmentOperation({
				requestedPath: path,
				ref,
				inputMode: "json"
			}));
			continue;
		}
		if (entry.provider !== void 0) {
			const alias = parseProviderAliasPath(path);
			const validated = SecretProviderSchema.safeParse(entry.provider);
			if (!validated.success) {
				const issue = validated.error.issues[0];
				const issuePath = issue?.path?.join(".") ?? "<provider>";
				throw new Error(`batch[${index}].provider invalid at ${issuePath}: ${issue?.message ?? ""}`);
			}
			operations.push({
				inputMode: "json",
				requestedPath: path,
				setPath: path,
				value: validated.data,
				schemaValidated: true,
				touchedProviderAlias: alias
			});
			continue;
		}
		operations.push(buildValueAssignmentOperation({
			requestedPath: path,
			value: entry.value,
			inputMode: "json"
		}));
	}
	return operations;
}
function configPatchModeError(message) {
	return /* @__PURE__ */ new Error(`config patch mode error: ${message}`);
}
async function readStdinText() {
	const chunks = [];
	let bytes = 0;
	if (process.stdin.isTTY) throw configPatchModeError("--stdin refuses to read from an interactive terminal; pipe input or use --file <path>.");
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		const text = String(chunk);
		bytes += Buffer.byteLength(text, "utf8");
		if (bytes > CONFIG_PATCH_STDIN_MAX_BYTES) throw configPatchModeError(`--stdin input exceeds ${CONFIG_PATCH_STDIN_MAX_BYTES} bytes; use --file <path> for larger patches.`);
		chunks.push(text);
	}
	return chunks.join("");
}
async function readConfigPatchInput(opts) {
	const file = normalizeOptionalString(opts.file);
	const stdin = Boolean(opts.stdin);
	if (Boolean(file) === stdin) throw configPatchModeError("provide exactly one of --file <path> or --stdin.");
	const sourceLabel = stdin ? "--stdin" : "--file";
	const raw = stdin ? await readStdinText() : fs.readFileSync(file, "utf8");
	try {
		return JSON5.parse(raw);
	} catch (err) {
		throw new Error(`Failed to parse ${sourceLabel} as JSON5: ${String(err)}`, { cause: err });
	}
}
function parseReplacePaths(paths) {
	return (paths ?? []).map((path) => parseRequiredPath(path));
}
function pathKey(path) {
	return JSON.stringify(path);
}
function buildDeleteOperation(path) {
	return {
		inputMode: "json",
		requestedPath: path,
		setPath: path,
		value: void 0,
		mutation: "delete"
	};
}
function buildUnsetOperation(path) {
	const resolved = resolveConfigSecretTargetByPath(path);
	const providerAlias = parseProviderAliasFromTargetPath(path);
	return {
		inputMode: "unset",
		requestedPath: path,
		setPath: path,
		value: void 0,
		mutation: "delete",
		...touchesSecretProviderCollection(path) || touchesSecretDefaults(path) ? { touchesAllSecretRefs: true } : {},
		...resolved ? { touchedSecretTargetPath: toDotPath(resolved.pathSegments) } : {},
		...providerAlias ? { touchedProviderAlias: providerAlias } : {}
	};
}
function buildApplyValueOperation(params) {
	if (isPlainRecord(params.value) ? coerceSecretRef(params.value) : null) return {
		...buildRefAssignmentOperation({
			requestedPath: params.path,
			ref: parseSecretRefFromUnknown(params.value, `patch.${toDotPath(params.path)}`),
			inputMode: "json"
		}),
		...params.mutation ? { mutation: params.mutation } : {}
	};
	return {
		...buildValueAssignmentOperation({
			requestedPath: params.path,
			value: params.value,
			inputMode: "json"
		}),
		...params.mutation ? { mutation: params.mutation } : {}
	};
}
function buildConfigPatchOperations(params) {
	if (!isPlainRecord(params.patch)) throw configPatchModeError("input must be a JSON5 object patch.");
	const operations = [];
	const replacePathKeys = new Set(params.replacePaths.map(pathKey));
	const matchedReplacePathKeys = /* @__PURE__ */ new Set();
	const visit = (value, path) => {
		validatePathSegments(path);
		const replacementKey = pathKey(path);
		if (path.length > 0 && replacePathKeys.has(replacementKey)) {
			matchedReplacePathKeys.add(replacementKey);
			operations.push(value === null ? buildDeleteOperation(path) : buildApplyValueOperation({
				path,
				value,
				mutation: "replace"
			}));
			return;
		}
		if (path.length > 0 && value === null) {
			operations.push(buildDeleteOperation(path));
			return;
		}
		if (path.length > 0 && isPlainRecord(value) && coerceSecretRef(value)) {
			operations.push(buildApplyValueOperation({
				path,
				value
			}));
			return;
		}
		if (isPlainRecord(value)) {
			if (path.length > 0 && Object.keys(value).length === 0) {
				operations.push(buildApplyValueOperation({
					path,
					value,
					mutation: "merge"
				}));
				return;
			}
			for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
			return;
		}
		if (path.length === 0) throw configPatchModeError("input must contain at least one config key.");
		operations.push(buildApplyValueOperation({
			path,
			value
		}));
	};
	visit(params.patch, []);
	const unusedReplacePath = params.replacePaths.find((path) => !matchedReplacePathKeys.has(pathKey(path)));
	if (unusedReplacePath) throw configPatchModeError(`--replace-path ${toDotPath(unusedReplacePath)} did not match any value in the input patch.`);
	if (operations.length === 0) throw configPatchModeError("input patch did not contain any config updates.");
	return operations;
}
function collectSecretRefsFromUnknown(value) {
	const refs = [];
	const visit = (candidate) => {
		const ref = coerceSecretRef(candidate);
		if (ref) {
			refs.push(ref);
			return;
		}
		if (Array.isArray(candidate)) {
			for (const entry of candidate) visit(entry);
			return;
		}
		if (isPlainRecord(candidate)) for (const entry of Object.values(candidate)) visit(entry);
	};
	visit(value);
	return refs;
}
function modeError(message) {
	return /* @__PURE__ */ new Error(`config set mode error: ${message}`);
}
function buildSingleSetOperations(params) {
	const pathProvided = typeof params.path === "string" && params.path.trim().length > 0;
	const parsedPath = pathProvided ? parseRequiredPath(params.path) : null;
	const strictJson = Boolean(params.opts.strictJson || params.opts.json);
	const modeResolution = resolveConfigSetMode({
		hasBatchMode: false,
		hasRefBuilderOptions: hasRefBuilderOptions(params.opts),
		hasProviderBuilderOptions: hasProviderBuilderOptions(params.opts),
		strictJson
	});
	if (!modeResolution.ok) throw modeError(modeResolution.error);
	if (modeResolution.mode === "ref_builder") {
		if (!pathProvided || !parsedPath) throw modeError("ref builder mode requires <path>.");
		if (params.value !== void 0) throw modeError("ref builder mode does not accept <value>.");
		if (!params.opts.refProvider || !params.opts.refSource || !params.opts.refId) throw modeError("ref builder mode requires --ref-provider <alias>, --ref-source <env|file|exec>, and --ref-id <id>.");
		return [buildRefAssignmentOperation({
			requestedPath: parsedPath,
			ref: parseSecretRefBuilder({
				provider: params.opts.refProvider,
				source: params.opts.refSource,
				id: params.opts.refId,
				fieldPrefix: "ref"
			}),
			inputMode: "builder"
		})];
	}
	if (modeResolution.mode === "provider_builder") {
		if (!pathProvided || !parsedPath) throw modeError("provider builder mode requires <path>.");
		if (params.value !== void 0) throw modeError("provider builder mode does not accept <value>.");
		const alias = parseProviderAliasPath(parsedPath);
		return [{
			inputMode: "builder",
			requestedPath: parsedPath,
			setPath: parsedPath,
			value: buildProviderFromBuilder(params.opts),
			schemaValidated: true,
			touchedProviderAlias: alias
		}];
	}
	if (!pathProvided || !parsedPath) throw modeError("value/json mode requires <path> when batch mode is not used.");
	if (params.value === void 0) throw modeError("value/json mode requires <value>.");
	return [buildValueAssignmentOperation({
		requestedPath: parsedPath,
		value: parseValue(params.value, { strictJson }),
		inputMode: modeResolution.mode === "json" ? "json" : "value"
	})];
}
function collectDryRunRefs(params) {
	const refsByKey = /* @__PURE__ */ new Map();
	const targetPaths = /* @__PURE__ */ new Set();
	const providerAliases = /* @__PURE__ */ new Set();
	let includeAllDiscoveredRefs = false;
	for (const operation of params.operations) {
		if (operation.assignedRef) refsByKey.set(secretRefKey(operation.assignedRef), operation.assignedRef);
		for (const ref of collectSecretRefsFromUnknown(operation.value)) refsByKey.set(secretRefKey(ref), ref);
		if (operation.touchedSecretTargetPath) targetPaths.add(operation.touchedSecretTargetPath);
		if (operation.touchedProviderAlias) providerAliases.add(operation.touchedProviderAlias);
		includeAllDiscoveredRefs ||= operation.touchesAllSecretRefs === true;
	}
	if (!includeAllDiscoveredRefs && targetPaths.size === 0 && providerAliases.size === 0) return [...refsByKey.values()];
	const defaults = params.config.secrets?.defaults;
	for (const target of discoverConfigSecretTargets(params.config)) {
		const { ref } = resolveSecretInputRef({
			value: target.value,
			refValue: target.refValue,
			defaults
		});
		if (!ref) continue;
		if (includeAllDiscoveredRefs || targetPaths.has(target.path) || providerAliases.has(ref.provider)) refsByKey.set(secretRefKey(ref), ref);
	}
	return [...refsByKey.values()];
}
async function collectDryRunResolvabilityErrors(params) {
	const failures = [];
	for (const ref of params.refs) try {
		await resolveSecretRefValue(ref, {
			config: params.config,
			env: process.env
		});
	} catch (err) {
		failures.push({
			kind: "resolvability",
			message: String(err),
			ref: `${ref.source}:${ref.provider}:${ref.id}`
		});
	}
	return failures;
}
function collectDryRunStaticErrorsForSkippedExecRefs(params) {
	const failures = [];
	for (const ref of params.refs) {
		const id = ref.id.trim();
		const refLabel = `${ref.source}:${ref.provider}:${id}`;
		if (!id) {
			failures.push({
				kind: "resolvability",
				message: "Error: Secret reference id is empty.",
				ref: refLabel
			});
			continue;
		}
		if (!isValidExecSecretRefId(id)) {
			failures.push({
				kind: "resolvability",
				message: `Error: ${formatExecSecretRefIdValidationMessage()} (ref: ${refLabel}).`,
				ref: refLabel
			});
			continue;
		}
		const providerConfig = params.config.secrets?.providers?.[ref.provider];
		if (!providerConfig) {
			failures.push({
				kind: "resolvability",
				message: `Error: Secret provider "${ref.provider}" is not configured (ref: ${refLabel}).`,
				ref: refLabel
			});
			continue;
		}
		if (providerConfig.source !== ref.source) failures.push({
			kind: "resolvability",
			message: `Error: Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "${ref.source}".`,
			ref: refLabel
		});
	}
	return failures;
}
function selectDryRunRefsForResolution(params) {
	const refsToResolve = [];
	const skippedExecRefs = [];
	for (const ref of params.refs) {
		if (ref.source === "exec" && !params.allowExecInDryRun) {
			skippedExecRefs.push(ref);
			continue;
		}
		refsToResolve.push(ref);
	}
	return {
		refsToResolve,
		skippedExecRefs
	};
}
function pathStartsWith(path, prefix) {
	return prefix.every((segment, index) => path[index] === segment);
}
function formatPluginInstallConfigSetError() {
	return [
		"plugins.installs is managed by the plugin index and cannot be edited with config set.",
		"",
		"Use plugin commands instead:",
		`  ${formatCliCommand("openclaw plugins install <spec>")}`,
		`  ${formatCliCommand("openclaw plugins update <plugin-id>")}`,
		`  ${formatCliCommand("openclaw plugins uninstall <plugin-id>")}`
	].join("\n");
}
function isAutoManagedMetaPath(path) {
	return AUTO_MANAGED_CONFIG_META_PATHS.some((managedPath) => pathStartsWith(path, managedPath));
}
function valueHasAutoManagedChild(value, childPath) {
	let cursor = value;
	for (const segment of childPath) {
		if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return false;
		if (typeof segment !== "string") return false;
		const record = cursor;
		if (!Object.prototype.hasOwnProperty.call(record, segment)) return false;
		cursor = record[segment];
	}
	return cursor !== void 0;
}
function operationClobbersAncestorChild(operation, managedPath, options) {
	if (operation.mutation === "delete") return true;
	const childPath = managedPath.slice(operation.requestedPath.length);
	if (operation.mutation === "merge" || Boolean(options.merge) && operation.mutation !== "replace") return valueHasAutoManagedChild(operation.value, childPath);
	return true;
}
function findAutoManagedMetaTargets(operations, options = {}) {
	const matches = [];
	const seen = /* @__PURE__ */ new Set();
	const record = (path) => {
		const segments = [...path];
		const key = toDotPath(segments);
		if (seen.has(key)) return;
		seen.add(key);
		matches.push(segments);
	};
	for (const operation of operations) {
		if (isAutoManagedMetaPath(operation.requestedPath)) {
			record(operation.requestedPath);
			continue;
		}
		for (const managedPath of AUTO_MANAGED_CONFIG_META_PATHS) {
			if (operation.requestedPath.length >= managedPath.length) continue;
			if (!pathStartsWith(managedPath, operation.requestedPath)) continue;
			if (operationClobbersAncestorChild(operation, managedPath, options)) record(managedPath);
		}
	}
	return matches;
}
function findAutoManagedMetaUnsetTargets(path) {
	return findAutoManagedMetaTargets([{
		inputMode: "json",
		requestedPath: [...path],
		setPath: [...path],
		value: void 0,
		mutation: "delete"
	}]);
}
function formatAutoManagedMetaError(paths) {
	const targets = paths.map((path) => toDotPath(path));
	return [
		`${targets.length === 1 ? targets[0] : targets.join(", ")} is auto-managed by OpenClaw and cannot be edited; the value would be overwritten on the next config write.`,
		"",
		"These fields are stamped on every config write to record the OpenClaw version and timestamp that produced the file."
	].join("\n");
}
async function loadConfigMutationSchema() {
	try {
		return structuredClone((await readBestEffortRuntimeConfigSchema()).schema);
	} catch {
		return;
	}
}
function collectDryRunSchemaErrors(params) {
	const validated = validateConfigObjectRawWithPlugins(params.config);
	if (validated.ok) return [];
	return formatConfigIssueLines(validated.issues, "-", { normalizeRoot: true }).map((message) => ({
		kind: "schema",
		message
	}));
}
function dedupeDryRunErrors(errors) {
	const deduped = [];
	const seen = /* @__PURE__ */ new Set();
	for (const error of errors) {
		const key = error.kind === "resolvability" ? `${error.kind}\u0000${error.ref ?? ""}\u0000${error.message}` : `${error.kind}\u0000${error.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(error);
	}
	return deduped;
}
function formatDryRunFailureMessage(params) {
	const { errors, skippedExecRefs } = params;
	const missingPathErrors = errors.filter((error) => error.kind === "missing-path");
	const schemaErrors = errors.filter((error) => error.kind === "schema");
	const resolveErrors = errors.filter((error) => error.kind === "resolvability");
	const lines = [];
	if (missingPathErrors.length > 0) lines.push(...missingPathErrors.map((error) => error.message));
	if (schemaErrors.length > 0) {
		lines.push("Dry run failed: config schema validation failed.");
		lines.push(...schemaErrors.map((error) => `- ${error.message}`));
	}
	if (resolveErrors.length > 0) {
		lines.push(`Dry run failed: ${resolveErrors.length} SecretRef assignment(s) could not be resolved.`);
		lines.push(...resolveErrors.slice(0, 5).map((error) => `- ${error.ref ?? "<unknown-ref>"} -> ${error.message}`));
		if (resolveErrors.length > 5) lines.push(`- ... ${resolveErrors.length - 5} more`);
	}
	if (skippedExecRefs > 0) lines.push(`Dry run note: skipped ${skippedExecRefs} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during dry-run.`);
	return lines.join("\n");
}
async function runConfigOperations(params) {
	const { runtime, operations, options } = params;
	if (operations.some((operation) => pathStartsWith(operation.requestedPath, PLUGIN_INSTALL_RECORD_PATH_PREFIX))) throw new Error(formatPluginInstallConfigSetError());
	const autoManagedMetaTargets = findAutoManagedMetaTargets(operations, { merge: options.merge });
	if (autoManagedMetaTargets.length > 0) throw new Error(formatAutoManagedMetaError(autoManagedMetaTargets));
	const snapshot = await loadValidConfig(runtime);
	const next = structuredClone(snapshot.resolved);
	const mutationSchema = await loadConfigMutationSchema();
	const unsetPaths = [];
	const explicitSetPaths = [];
	for (const operation of operations) {
		if (operation.mutation === "delete") {
			unsetAtPath(next, operation.setPath);
			unsetPaths.push(operation.setPath);
			continue;
		}
		explicitSetPaths.push(operation.setPath);
		if (operation.mutation === "merge" || options.merge && operation.mutation !== "replace") mergeAtPath(next, operation.setPath, operation.value, {
			numericObjectKeys: params.successMode === "patch",
			schema: mutationSchema
		});
		else {
			assertNonDestructiveReplacement({
				root: next,
				path: operation.setPath,
				value: operation.value,
				allowReplace: options.replace || operation.mutation === "replace"
			});
			setAtPath(next, operation.setPath, operation.value, {
				numericObjectKeys: params.successMode === "patch",
				schema: mutationSchema
			});
		}
	}
	const removedGatewayAuthPaths = pruneInactiveGatewayAuthCredentials({
		root: next,
		operations
	});
	const nextConfig = normalizeConfigMutationModelRefs(next);
	const normalizedExplicitSetPaths = explicitSetPaths.map(normalizeConfigMutationExplicitSetPath);
	const policyIssueLines = formatConfigIssueLines(collectUnsupportedSecretRefPolicyIssues(nextConfig), "", { normalizeRoot: true }).map((line) => line.trim());
	if (options.dryRun) {
		const hasJsonMode = operations.some((operation) => operation.inputMode === "json");
		const hasBuilderMode = operations.some((operation) => operation.inputMode === "builder");
		const hasUnsetMode = operations.some((operation) => operation.inputMode === "unset");
		const requiresFullSchemaValidation = operations.some((operation) => operation.inputMode === "unset" || operation.inputMode === "json" && operation.schemaValidated !== true);
		const selectedDryRunRefs = selectDryRunRefsForResolution({
			refs: hasJsonMode || hasBuilderMode || hasUnsetMode ? collectDryRunRefs({
				config: nextConfig,
				operations
			}) : [],
			allowExecInDryRun: Boolean(options.allowExec)
		});
		const errors = [];
		if ((!hasJsonMode || !requiresFullSchemaValidation) && policyIssueLines.length > 0) errors.push(...policyIssueLines.map((message) => ({
			kind: "schema",
			message
		})));
		if (requiresFullSchemaValidation) errors.push(...collectDryRunSchemaErrors({ config: nextConfig }));
		if (hasJsonMode || hasBuilderMode || hasUnsetMode) {
			errors.push(...collectDryRunStaticErrorsForSkippedExecRefs({
				refs: selectedDryRunRefs.skippedExecRefs,
				config: nextConfig
			}));
			errors.push(...await collectDryRunResolvabilityErrors({
				refs: selectedDryRunRefs.refsToResolve,
				config: nextConfig
			}));
		}
		const dedupedErrors = dedupeDryRunErrors(errors);
		const dryRunResult = {
			ok: dedupedErrors.length === 0,
			operations: operations.length,
			configPath: shortenHomePath(snapshot.path),
			inputModes: [...new Set(operations.map((operation) => operation.inputMode))],
			checks: {
				schema: requiresFullSchemaValidation || policyIssueLines.length > 0,
				resolvability: hasJsonMode || hasBuilderMode || hasUnsetMode,
				resolvabilityComplete: (hasJsonMode || hasBuilderMode || hasUnsetMode) && selectedDryRunRefs.skippedExecRefs.length === 0
			},
			refsChecked: selectedDryRunRefs.refsToResolve.length,
			skippedExecRefs: selectedDryRunRefs.skippedExecRefs.length,
			...dedupedErrors.length > 0 ? { errors: dedupedErrors } : {}
		};
		if (dedupedErrors.length > 0) {
			if (options.json) throw new ConfigSetDryRunValidationError(dryRunResult);
			throw new Error(formatDryRunFailureMessage({
				errors: dedupedErrors,
				skippedExecRefs: selectedDryRunRefs.skippedExecRefs.length
			}));
		}
		if (options.json) writeRuntimeJson(runtime, dryRunResult);
		else {
			if (!dryRunResult.checks.schema && !dryRunResult.checks.resolvability) runtime.log(info("Dry run note: value mode does not run schema/resolvability checks. Use --strict-json, builder flags, or batch mode to enable validation checks."));
			if (dryRunResult.skippedExecRefs > 0) runtime.log(info(`Dry run note: skipped ${dryRunResult.skippedExecRefs} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during dry-run.`));
			runtime.log(info(`Dry run successful: ${operations.length} update(s) validated against ${shortenHomePath(snapshot.path)}.`));
		}
		return;
	}
	if (policyIssueLines.length > 0) throw new Error(formatUnsupportedSecretRefPolicyFailureMessage(policyIssueLines));
	await replaceConfigFile({
		nextConfig,
		...snapshot.hash !== void 0 ? { baseHash: snapshot.hash } : {},
		...unsetPaths.length > 0 || explicitSetPaths.length > 0 ? { writeOptions: {
			...unsetPaths.length > 0 ? { unsetPaths } : {},
			...normalizedExplicitSetPaths.length > 0 ? { explicitSetPaths: normalizedExplicitSetPaths } : {}
		} } : {}
	});
	if (removedGatewayAuthPaths.length > 0) runtime.log(info(`Removed inactive ${removedGatewayAuthPaths.join(", ")} for gateway.auth.mode=${nextConfig.gateway?.auth?.mode ?? "<unset>"}.`));
	if (params.successMode === "set" && operations.length === 1) {
		const operation = operations[0];
		const action = operation?.mutation === "delete" ? "Removed" : "Updated";
		runtime.log(info(`${action} ${toDotPath(operation?.requestedPath ?? [])}. Restart the gateway to apply.`));
		return;
	}
	if (params.successMode === "set") {
		runtime.log(info(`Updated ${operations.length} config paths. Restart the gateway to apply.`));
		return;
	}
	runtime.log(info(`Applied ${operations.length} config update(s). Restart the gateway to apply.`));
}
function handleConfigMutationError(params) {
	if (params.options.dryRun && params.options.json && params.err instanceof ConfigSetDryRunValidationError) {
		writeRuntimeJson(params.runtime, params.err.result);
		params.runtime.exit(1);
		return;
	}
	params.runtime.error(danger(String(params.err)));
	params.runtime.exit(1);
}
async function runConfigSet(opts) {
	const runtime = opts.runtime ?? defaultRuntime;
	try {
		const modeResolution = resolveConfigSetMode({
			hasBatchMode: hasBatchMode(opts.cliOptions),
			hasRefBuilderOptions: hasRefBuilderOptions(opts.cliOptions),
			hasProviderBuilderOptions: hasProviderBuilderOptions(opts.cliOptions),
			strictJson: Boolean(opts.cliOptions.strictJson || opts.cliOptions.json)
		});
		if (!modeResolution.ok) throw modeError(modeResolution.error);
		if (opts.cliOptions.allowExec && !opts.cliOptions.dryRun) throw modeError("--allow-exec requires --dry-run.");
		if (opts.cliOptions.merge && opts.cliOptions.replace) throw modeError("choose either --merge or --replace, not both.");
		const batchEntries = parseBatchSource(opts.cliOptions);
		if (batchEntries) {
			if (opts.path !== void 0 || opts.value !== void 0) throw modeError("batch mode does not accept <path> or <value> arguments.");
		}
		await runConfigOperations({
			runtime,
			operations: batchEntries ? parseBatchOperations(batchEntries) : buildSingleSetOperations({
				path: opts.path,
				value: opts.value,
				opts: opts.cliOptions
			}),
			options: opts.cliOptions,
			successMode: "set"
		});
	} catch (err) {
		handleConfigMutationError({
			err,
			runtime,
			options: opts.cliOptions
		});
	}
}
async function runConfigPatch(opts) {
	const runtime = opts.runtime ?? defaultRuntime;
	try {
		if (opts.cliOptions.allowExec && !opts.cliOptions.dryRun) throw configPatchModeError("--allow-exec requires --dry-run.");
		if (opts.cliOptions.json && !opts.cliOptions.dryRun) throw configPatchModeError("--json requires --dry-run.");
		await runConfigOperations({
			runtime,
			operations: buildConfigPatchOperations({
				patch: await readConfigPatchInput(opts.cliOptions),
				replacePaths: parseReplacePaths(opts.cliOptions.replacePath)
			}),
			options: {
				dryRun: opts.cliOptions.dryRun,
				allowExec: opts.cliOptions.allowExec,
				json: opts.cliOptions.json
			},
			successMode: "patch"
		});
	} catch (err) {
		handleConfigMutationError({
			err,
			runtime,
			options: opts.cliOptions
		});
	}
}
async function runConfigGet(opts) {
	const runtime = opts.runtime ?? defaultRuntime;
	try {
		const parsedPath = parseRequiredPath(opts.path);
		const res = getAtPath(redactConfigObject((await loadValidConfig(runtime)).config), parsedPath);
		if (!res.found) {
			runtime.error(danger(`Config path not found: ${opts.path}. Run ${formatCliCommand("openclaw config validate")} to inspect config shape.`));
			runtime.exit(1);
			return;
		}
		if (opts.json) {
			writeRuntimeJson(runtime, res.value ?? null);
			return;
		}
		if (typeof res.value === "string" || typeof res.value === "number" || typeof res.value === "boolean") {
			runtime.log(String(res.value));
			return;
		}
		writeRuntimeJson(runtime, res.value ?? null);
	} catch (err) {
		runtime.error(danger(String(err)));
		runtime.exit(1);
	}
}
async function runConfigUnset(opts) {
	const runtime = opts.runtime ?? defaultRuntime;
	const cliOptions = opts.cliOptions ?? {};
	try {
		if (cliOptions.allowExec && !cliOptions.dryRun) throw new Error("--allow-exec can only be used with --dry-run.");
		if (cliOptions.json && !cliOptions.dryRun) throw new Error("--json can only be used with --dry-run.");
		const parsedPath = parseRequiredPath(opts.path);
		const autoManagedUnsetTargets = findAutoManagedMetaUnsetTargets(parsedPath);
		if (autoManagedUnsetTargets.length > 0) throw new Error(formatAutoManagedMetaError(autoManagedUnsetTargets));
		const snapshot = await loadValidConfig(runtime);
		const next = structuredClone(snapshot.resolved);
		const unsetResult = unsetAtPath(next, parsedPath);
		if (!unsetResult.removed) {
			if (cliOptions.dryRun && cliOptions.json) throw new ConfigSetDryRunValidationError({
				ok: false,
				operations: 1,
				configPath: shortenHomePath(snapshot.path),
				inputModes: ["unset"],
				checks: {
					schema: false,
					resolvability: false,
					resolvabilityComplete: false
				},
				refsChecked: 0,
				skippedExecRefs: 0,
				errors: [{
					kind: "missing-path",
					message: `Config path not found: ${opts.path}. Nothing was changed.`
				}]
			});
			runtime.error(danger(`Config path not found: ${opts.path}. Nothing was changed. Run ${formatCliCommand("openclaw config get <path>")} first if you are unsure of the path.`));
			runtime.exit(1);
			return;
		}
		if (cliOptions.dryRun) {
			await runConfigOperations({
				runtime,
				operations: [buildUnsetOperation(parsedPath)],
				options: cliOptions,
				successMode: "set"
			});
			return;
		}
		await replaceConfigFile({
			nextConfig: next,
			...snapshot.hash !== void 0 ? { baseHash: snapshot.hash } : {},
			...unsetResult.leafContainer === "array" ? {} : { writeOptions: { unsetPaths: [parsedPath] } }
		});
		runtime.log(info(`Removed ${opts.path}. Restart the gateway to apply.`));
	} catch (err) {
		handleConfigMutationError({
			err,
			runtime,
			options: cliOptions
		});
	}
}
async function runConfigFile(opts) {
	const runtime = opts.runtime ?? defaultRuntime;
	try {
		const snapshot = await readConfigFileSnapshot();
		runtime.log(shortenHomePath(snapshot.path));
	} catch (err) {
		runtime.error(danger(String(err)));
		runtime.exit(1);
	}
}
async function buildCliConfigSchema() {
	const schema = structuredClone((await readBestEffortRuntimeConfigSchema()).schema);
	schema.properties = {
		$schema: { type: "string" },
		...schema.properties
	};
	return schema;
}
async function runConfigSchema(opts = {}) {
	const runtime = opts.runtime ?? defaultRuntime;
	try {
		writeRuntimeJson(runtime, await buildCliConfigSchema());
	} catch (err) {
		runtime.error(danger(`Config schema error: ${String(err)}`));
		runtime.exit(1);
	}
}
async function runConfigValidate(opts = {}) {
	const runtime = opts.runtime ?? defaultRuntime;
	let outputPath = CONFIG_PATH ?? "openclaw.json";
	try {
		const snapshot = await readConfigFileSnapshot();
		outputPath = snapshot.path;
		const shortPath = shortenHomePath(outputPath);
		if (!snapshot.exists) {
			if (opts.json) writeRuntimeJson(runtime, {
				valid: false,
				path: outputPath,
				error: "file not found"
			}, 0);
			else {
				runtime.error(danger(`Config file not found: ${shortPath}`));
				runtime.error(`Create one with ${formatCliCommand("openclaw onboard")} or run ${formatCliCommand("openclaw doctor --fix")}.`);
			}
			runtime.exit(1);
			return;
		}
		if (!snapshot.valid) {
			const issues = normalizeConfigIssues(snapshot.issues);
			if (opts.json) writeRuntimeJson(runtime, {
				valid: false,
				path: outputPath,
				issues
			});
			else {
				runtime.error(danger(`OpenClaw config is invalid: ${shortPath}`));
				for (const line of formatConfigIssueLines(issues, danger("×"), { normalizeRoot: true })) runtime.error(`  ${line}`);
				runtime.error("");
				runtime.error(formatDoctorHint("to repair, or fix the keys above manually."));
				runtime.error(`Inspect with ${formatCliCommand("openclaw config validate")}.`);
			}
			runtime.exit(1);
			return;
		}
		if (opts.json) writeRuntimeJson(runtime, {
			valid: true,
			path: outputPath
		}, 0);
		else runtime.log(success(`Config valid: ${shortPath}`));
	} catch (err) {
		if (opts.json) writeRuntimeJson(runtime, {
			valid: false,
			path: outputPath,
			error: String(err)
		}, 0);
		else runtime.error(danger(`Config validation error: ${String(err)}`));
		runtime.exit(1);
	}
}
function registerConfigCli(program) {
	const cmd = program.command("config").description("Non-interactive config helpers (get/set/patch/unset/file/schema/validate). Run without subcommand for guided setup.").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/config", "docs.openclaw.ai/cli/config")}\n`).option("--section <section>", "Configuration sections for guided setup (repeatable). Use with no subcommand.", (value, previous) => [...previous, value], []).action(async (opts) => {
		const { configureCommandFromSectionsArg } = await import("./configure-B-nHBTkJ.js");
		await configureCommandFromSectionsArg(opts.section, defaultRuntime);
	});
	cmd.command("get").description("Get a config value by dot path").argument("<path>", "Config path (dot or bracket notation)").option("--json", "Output JSON", false).action(async (path, opts) => {
		await runConfigGet({
			path,
			json: Boolean(opts.json)
		});
	});
	setCommandJsonMode(cmd.command("set"), "parse-only").description(CONFIG_SET_DESCRIPTION).argument("[path]", "Config path (dot or bracket notation)").argument("[value]", "Value (JSON/JSON5 or raw string)").option("--strict-json", "Strict JSON parsing (error instead of raw string fallback)", false).option("--json", "Legacy alias for --strict-json", false).option("--dry-run", "Validate changes without writing openclaw.json (checks run in builder/json/batch modes; exec SecretRefs are skipped unless --allow-exec is set)", false).option("--allow-exec", "Dry-run only: allow exec SecretRef resolvability checks (may execute provider commands)", false).option("--merge", "Merge object/map values instead of replacing the target path", false).option("--replace", "Allow full replacement of protected map/list paths such as agents.defaults.models", false).option("--ref-provider <alias>", "SecretRef builder: provider alias").option("--ref-source <source>", "SecretRef builder: source (env|file|exec)").option("--ref-id <id>", "SecretRef builder: ref id").option("--provider-source <source>", "Provider builder: source (env|file|exec)").option("--provider-allowlist <envVar>", "Provider builder (env): allowlist entry (repeatable)", (value, previous) => [...previous, value], []).option("--provider-path <path>", "Provider builder (file): path").option("--provider-mode <mode>", "Provider builder (file): mode (singleValue|json)").option("--provider-timeout-ms <ms>", "Provider builder (file|exec): timeout ms").option("--provider-max-bytes <bytes>", "Provider builder (file): max bytes").option("--provider-command <path>", "Provider builder (exec): absolute command path").option("--provider-arg <arg>", "Provider builder (exec): command arg (repeatable)", (value, previous) => [...previous, value], []).option("--provider-no-output-timeout-ms <ms>", "Provider builder (exec): no-output timeout ms").option("--provider-max-output-bytes <bytes>", "Provider builder (exec): max output bytes").option("--provider-json-only", "Provider builder (exec): require JSON output", false).option("--provider-env <key=value>", "Provider builder (exec): env assignment (repeatable)", (value, previous) => [...previous, value], []).option("--provider-pass-env <envVar>", "Provider builder (exec): pass host env var (repeatable)", (value, previous) => [...previous, value], []).option("--provider-trusted-dir <path>", "Provider builder (exec): trusted directory (repeatable)", (value, previous) => [...previous, value], []).option("--provider-allow-insecure-path", "Provider builder (file|exec): bypass strict path permission checks", false).option("--provider-allow-symlink-command", "Provider builder (exec): allow command symlink path", false).option("--batch-json <json>", "Batch mode: JSON array of set operations").option("--batch-file <path>", "Batch mode: read JSON array of set operations from file").action(async (path, value, opts) => {
		await runConfigSet({
			path,
			value,
			cliOptions: opts
		});
	});
	cmd.command("patch").description(CONFIG_PATCH_DESCRIPTION).option("--file <path>", "Read a JSON5 config patch object from file").option("--stdin", "Read a JSON5 config patch object from stdin", false).option("--dry-run", "Validate changes without writing openclaw.json (checks schema and SecretRef resolvability; exec SecretRefs are skipped unless --allow-exec is set)", false).option("--allow-exec", "Dry-run only: allow exec SecretRef resolvability checks (may execute provider commands)", false).option("--json", "Output dry-run result as JSON", false).option("--replace-path <path>", "Replace the object or array at this dot/bracket path instead of recursively applying it (repeatable)", (value, previous) => [...previous, value], []).action(async (opts) => {
		await runConfigPatch({ cliOptions: opts });
	});
	cmd.command("unset").description("Remove a config value by dot path").argument("<path>", "Config path (dot or bracket notation)").option("--dry-run", "validate the removal without writing the config file").option("--allow-exec", "allow exec SecretRef providers during --dry-run").option("--json", "print dry-run result as JSON").action(async (path, options) => {
		await runConfigUnset({
			path,
			cliOptions: options
		});
	});
	cmd.command("file").description("Print the active config file path").action(async () => {
		await runConfigFile({});
	});
	cmd.command("schema").description("Print the JSON schema for openclaw.json").action(async () => {
		await runConfigSchema({});
	});
	cmd.command("validate").description("Validate the current config against the schema without starting the gateway").option("--json", "Output validation result as JSON", false).action(async (opts) => {
		await runConfigValidate({ json: Boolean(opts.json) });
	});
}
//#endregion
export { registerConfigCli, runConfigFile, runConfigGet, runConfigPatch, runConfigSchema, runConfigSet, runConfigUnset, runConfigValidate };
