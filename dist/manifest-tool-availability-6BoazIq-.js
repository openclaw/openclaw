import { o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { l as resolveDefaultSecretProviderAlias } from "./ref-contract-D_h_G00C.js";
//#region src/plugins/manifest-tool-availability.ts
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function readPath(root, path) {
	if (!path?.trim()) return root;
	let current = root;
	for (const segment of path.split(".")) {
		const key = segment.trim();
		if (!key) return;
		if (!isRecord(current) || !(key in current)) return;
		current = current[key];
	}
	return current;
}
function readStringAtPath(root, path) {
	const value = readPath(root, path);
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readEffectiveConfig(params) {
	const root = readPath(params.config, params.rootPath);
	if (!isRecord(root)) return;
	const overlay = readPath(root, params.overlayPath);
	return isRecord(overlay) ? {
		...root,
		...overlay
	} : root;
}
function hasConfiguredSecretRefInConfigPath(params) {
	const providerConfig = params.config?.secrets?.providers?.[params.ref.provider];
	if (params.ref.source !== "env") return Boolean(providerConfig && providerConfig.source === params.ref.source);
	if (!providerConfig) return params.ref.provider === resolveDefaultSecretProviderAlias(params.config ?? {}, "env");
	if (providerConfig.source !== "env") return false;
	const allowlist = providerConfig.allowlist;
	return !allowlist || allowlist.includes(params.ref.id);
}
function hasConfiguredValue(params) {
	const secretRef = coerceSecretRef(params.value, params.config?.secrets?.defaults);
	if (secretRef) return hasConfiguredSecretRefInConfigPath({
		config: params.config,
		env: params.env,
		ref: secretRef
	}) && (secretRef.source !== "env" || Boolean(params.env[secretRef.id]?.trim()));
	if (typeof params.value === "string") return params.value.trim().length > 0;
	if (Array.isArray(params.value)) return params.value.length > 0;
	if (isRecord(params.value)) return Object.keys(params.value).length > 0;
	return params.value !== void 0 && params.value !== null;
}
function manifestConfigSignalPasses(params) {
	const effectiveConfig = readEffectiveConfig({
		config: params.config,
		rootPath: params.signal.rootPath,
		overlayPath: params.signal.overlayPath
	});
	if (!effectiveConfig) return false;
	const modeSignal = params.signal.mode;
	if (modeSignal) {
		const mode = readStringAtPath(effectiveConfig, modeSignal.path?.trim() || "mode") ?? modeSignal.default;
		if (!mode) return false;
		if (modeSignal.allowed?.length && !modeSignal.allowed.includes(mode)) return false;
		if (modeSignal.disallowed?.includes(mode)) return false;
	}
	for (const requiredPath of params.signal.required ?? []) if (!hasConfiguredValue({
		config: params.config,
		env: params.env,
		value: readPath(effectiveConfig, requiredPath)
	})) return false;
	const requiredAny = params.signal.requiredAny ?? [];
	if (requiredAny.length > 0 && !requiredAny.some((path) => hasConfiguredValue({
		config: params.config,
		env: params.env,
		value: readPath(effectiveConfig, path)
	}))) return false;
	return true;
}
function normalizeBaseUrlForManifestGuard(value) {
	return value.trim().replace(/\/+$/, "");
}
function manifestProviderBaseUrlGuardPasses(params) {
	const guard = params.guard;
	if (!guard) return true;
	const providerConfig = params.config?.models?.providers?.[guard.provider];
	const rawBaseUrl = typeof providerConfig?.baseUrl === "string" && providerConfig.baseUrl.trim() ? providerConfig.baseUrl : guard.defaultBaseUrl;
	if (!rawBaseUrl) return false;
	const normalizedBaseUrl = normalizeBaseUrlForManifestGuard(rawBaseUrl);
	return guard.allowedBaseUrls.some((allowedBaseUrl) => normalizeBaseUrlForManifestGuard(allowedBaseUrl) === normalizedBaseUrl);
}
function manifestPluginSetupProviderEnvVars(plugin, providerId) {
	const direct = plugin.setup?.providers?.find((provider) => provider.id === providerId)?.envVars;
	if (direct && direct.length > 0) return direct;
	return plugin.providerAuthEnvVars?.[providerId] ?? [];
}
function hasNonEmptyManifestEnvCandidate(env, envVars) {
	return envVars.some((envVar) => {
		const key = envVar.trim();
		return key.length > 0 && Boolean(env[key]?.trim());
	});
}
function listToolAuthSignals(metadata) {
	if (metadata.authSignals?.length) return metadata.authSignals;
	return [...metadata.authProviders ?? [], ...metadata.aliases ?? []].map((provider) => ({ provider }));
}
function toolMetadataPasses(params) {
	const authSignals = listToolAuthSignals(params.metadata);
	if (!params.metadata.configSignals?.length && authSignals.length === 0) return true;
	if (params.metadata.configSignals?.some((signal) => manifestConfigSignalPasses({
		config: params.config,
		env: params.env,
		signal
	}))) return true;
	for (const signal of authSignals) {
		if (!manifestProviderBaseUrlGuardPasses({
			config: params.config,
			guard: signal.providerBaseUrl
		})) continue;
		if (params.hasAuthForProvider?.(signal.provider)) return true;
		if (hasNonEmptyManifestEnvCandidate(params.env, manifestPluginSetupProviderEnvVars(params.plugin, signal.provider))) return true;
	}
	return false;
}
function hasManifestToolAvailability(params) {
	for (const toolName of params.toolNames) {
		const metadata = params.plugin.toolMetadata?.[toolName];
		if (!metadata) return true;
		if (toolMetadataPasses({
			plugin: params.plugin,
			metadata,
			config: params.config,
			env: params.env,
			hasAuthForProvider: params.hasAuthForProvider
		})) return true;
	}
	return false;
}
//#endregion
export { manifestProviderBaseUrlGuardPasses as a, manifestPluginSetupProviderEnvVars as i, hasNonEmptyManifestEnvCandidate as n, manifestConfigSignalPasses as r, hasManifestToolAvailability as t };
