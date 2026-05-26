//#region packages/memory-host-sdk/src/host/secret-input-utils.ts
const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const LEGACY_SECRETREF_ENV_MARKER_PREFIX = "secretref-env:";
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeSecretInputString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
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
function parseEnvTemplateSecretRef(value) {
	if (typeof value !== "string") return null;
	const match = ENV_SECRET_TEMPLATE_RE.exec(value.trim());
	if (!match) return null;
	return {
		source: "env",
		provider: DEFAULT_SECRET_PROVIDER_ALIAS,
		id: match[1] ?? ""
	};
}
function parseLegacySecretRefEnvMarker(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed.startsWith(LEGACY_SECRETREF_ENV_MARKER_PREFIX)) return null;
	const id = trimmed.slice(14);
	if (!ENV_SECRET_REF_ID_RE.test(id)) return null;
	return {
		source: "env",
		provider: DEFAULT_SECRET_PROVIDER_ALIAS,
		id
	};
}
function coerceSecretRef(value) {
	if (isSecretRef(value)) return value;
	if (isLegacySecretRefWithoutProvider(value)) return {
		source: value.source,
		provider: DEFAULT_SECRET_PROVIDER_ALIAS,
		id: value.id
	};
	return parseEnvTemplateSecretRef(value) ?? parseLegacySecretRefEnvMarker(value);
}
function hasConfiguredSecretInput(value) {
	if (normalizeSecretInputString(value)) return true;
	return coerceSecretRef(value) !== null;
}
function formatSecretRefLabel(ref) {
	return `${ref.source}:${ref.provider}:${ref.id}`;
}
function createUnresolvedSecretInputError(params) {
	return /* @__PURE__ */ new Error(`${params.path}: unresolved SecretRef "${formatSecretRefLabel(params.ref)}". Resolve this command against an active gateway runtime snapshot before reading it.`);
}
function resolveSecretInputRef(value) {
	return coerceSecretRef(value);
}
function normalizeResolvedSecretInputString(params) {
	const normalized = normalizeSecretInputString(params.value);
	if (normalized) return normalized;
	const ref = resolveSecretInputRef(params.value);
	if (!ref) return;
	throw createUnresolvedSecretInputError({
		path: params.path,
		ref
	});
}
function normalizeEnvSecretInputString(value) {
	return normalizeSecretInputString(value);
}
//#endregion
//#region packages/memory-host-sdk/src/host/secret-input.ts
function hasConfiguredMemorySecretInput(value) {
	return hasConfiguredSecretInput(value);
}
function resolveMemorySecretInputString(params) {
	const ref = resolveSecretInputRef(params.value);
	if (ref?.source === "env") {
		const envValue = normalizeEnvSecretInputString(process.env[ref.id]);
		if (envValue) return envValue;
	}
	return normalizeResolvedSecretInputString({
		value: params.value,
		path: params.path
	});
}
//#endregion
export { resolveMemorySecretInputString as n, hasConfiguredMemorySecretInput as t };
