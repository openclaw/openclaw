import { c as isRecord } from "./utils-D5swhEXt.js";
//#region src/config/types.secrets.ts
const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const LEGACY_SECRETREF_ENV_MARKER_PREFIX = "secretref-env:";
const LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX = "__env__:";
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
function isValidEnvSecretRefId(value) {
	return ENV_SECRET_REF_ID_RE.test(value);
}
function isSecretRef(value) {
	if (!isRecord(value)) return false;
	if (Object.keys(value).length !== 3) return false;
	return (value.source === "env" || value.source === "file" || value.source === "exec") && typeof value.provider === "string" && value.provider.trim().length > 0 && typeof value.id === "string" && value.id.trim().length > 0;
}
function isLegacySecretRefWithoutProvider(value) {
	if (!isRecord(value)) return false;
	return (value.source === "env" || value.source === "file" || value.source === "exec") && typeof value.id === "string" && value.id.trim().length > 0 && value.provider === void 0;
}
function parseEnvTemplateSecretRef(value, provider = DEFAULT_SECRET_PROVIDER_ALIAS) {
	if (typeof value !== "string") return null;
	const match = ENV_SECRET_TEMPLATE_RE.exec(value.trim());
	if (!match) return null;
	return {
		source: "env",
		provider: provider.trim() || "default",
		id: match[1]
	};
}
function parseLegacySecretRefEnvMarker(value, provider = DEFAULT_SECRET_PROVIDER_ALIAS) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const prefix = trimmed.startsWith("secretref-env:") ? LEGACY_SECRETREF_ENV_MARKER_PREFIX : trimmed.startsWith("__env__:") ? LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX : void 0;
	if (!prefix) return null;
	const id = trimmed.slice(prefix.length);
	if (!ENV_SECRET_REF_ID_RE.test(id)) return null;
	return {
		source: "env",
		provider: provider.trim() || "default",
		id
	};
}
function coerceSecretRef(value, defaults) {
	if (isSecretRef(value)) return value;
	const legacyEnvMarker = parseLegacySecretRefEnvMarker(value, defaults?.env);
	if (legacyEnvMarker) return legacyEnvMarker;
	if (isLegacySecretRefWithoutProvider(value)) {
		const provider = value.source === "env" ? defaults?.env ?? "default" : value.source === "file" ? defaults?.file ?? "default" : defaults?.exec ?? "default";
		return {
			source: value.source,
			provider,
			id: value.id
		};
	}
	const envTemplate = parseEnvTemplateSecretRef(value, defaults?.env);
	if (envTemplate) return envTemplate;
	return null;
}
function hasConfiguredSecretInput(value, defaults) {
	if (normalizeSecretInputString(value)) return true;
	return coerceSecretRef(value, defaults) !== null;
}
function normalizeSecretInputString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function formatSecretRefLabel(ref) {
	return `${ref.source}:${ref.provider}:${ref.id}`;
}
function createUnresolvedSecretInputError(params) {
	return /* @__PURE__ */ new Error(`${params.path}: unresolved SecretRef "${formatSecretRefLabel(params.ref)}". Resolve this command against an active gateway runtime snapshot before reading it.`);
}
function assertSecretInputResolved(params) {
	const { ref } = resolveSecretInputRef({
		value: params.value,
		refValue: params.refValue,
		defaults: params.defaults
	});
	if (!ref) return;
	throw createUnresolvedSecretInputError({
		path: params.path,
		ref
	});
}
function resolveSecretInputString(params) {
	const normalized = normalizeSecretInputString(params.value);
	if (normalized) return {
		status: "available",
		value: normalized,
		ref: null
	};
	const { ref } = resolveSecretInputRef({
		value: params.value,
		refValue: params.refValue,
		defaults: params.defaults
	});
	if (!ref) return {
		status: "missing",
		value: void 0,
		ref: null
	};
	if ((params.mode ?? "strict") === "strict") throw createUnresolvedSecretInputError({
		path: params.path,
		ref
	});
	return {
		status: "configured_unavailable",
		value: void 0,
		ref
	};
}
function normalizeResolvedSecretInputString(params) {
	const resolved = resolveSecretInputString({
		...params,
		mode: "strict"
	});
	if (resolved.status === "available") return resolved.value;
}
function resolveSecretInputRef(params) {
	const explicitRef = coerceSecretRef(params.refValue, params.defaults);
	const inlineRef = explicitRef ? null : coerceSecretRef(params.value, params.defaults);
	return {
		explicitRef,
		inlineRef,
		ref: explicitRef ?? inlineRef
	};
}
//#endregion
export { assertSecretInputResolved as a, isSecretRef as c, normalizeSecretInputString as d, parseEnvTemplateSecretRef as f, resolveSecretInputString as h, LEGACY_SECRETREF_ENV_MARKER_PREFIX as i, isValidEnvSecretRefId as l, resolveSecretInputRef as m, ENV_SECRET_REF_ID_RE as n, coerceSecretRef as o, parseLegacySecretRefEnvMarker as p, LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX as r, hasConfiguredSecretInput as s, DEFAULT_SECRET_PROVIDER_ALIAS as t, normalizeResolvedSecretInputString as u };
