import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import { n as loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import "./shared-Cv5g0_Ch.js";
import { i as setPathExistingStrict } from "./path-utils-BCEW_1WB.js";
import { u as secretRefKey } from "./ref-contract-D_h_G00C.js";
import { o as resolveSecretRefValues } from "./resolve-D1Ko6pWx.js";
import "./installed-plugin-index-records-BrXfmg6n.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { a as createLazyRuntimeSurface, i as createLazyRuntimeNamedExport } from "./lazy-runtime-D-7_JraP.js";
import { i as resolveBundledExplicitWebSearchProvidersFromPublicArtifacts, r as resolveBundledExplicitWebFetchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.explicit-BwvGaIk_.js";
import { c as pushInactiveSurfaceWarning, l as pushWarning } from "./runtime-shared-CPFXAPqc.js";
import { o as sortWebFetchProvidersForAutoDetect, r as sortWebSearchProvidersForAutoDetect } from "./web-search-providers.shared-C_XvZwgr.js";
//#region src/secrets/runtime-web-tools.shared.ts
const loadResolveManifestContractOwnerPluginId = createLazyRuntimeNamedExport(() => import("./runtime-web-tools-manifest.runtime.js"), "resolveManifestContractOwnerPluginId");
function pushInactiveProviderCredentialWarnings(params) {
	for (const provider of params.selection.providers) {
		if (provider.id === params.skipProviderId) continue;
		const value = params.selection.readConfiguredCredential({
			provider,
			config: params.selection.sourceConfig,
			toolConfig: params.selection.toolConfig
		});
		if (!params.selection.hasConfiguredSecretRef(value, params.selection.defaults)) continue;
		for (const path of params.selection.inactivePathsForProvider(provider)) pushInactiveSurfaceWarning({
			context: params.selection.context,
			path,
			details: params.details
		});
	}
}
function ensureObject(target, key) {
	const current = target[key];
	if (isRecord(current)) return current;
	const next = {};
	target[key] = next;
	return next;
}
function normalizeKnownProvider(value, providers) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return;
	if (providers.some((provider) => provider.id === normalized)) return normalized;
}
function hasConfiguredSecretRef(value, defaults) {
	return Boolean(resolveSecretInputRef({
		value,
		defaults
	}).ref);
}
function getProviderEnvVars(provider) {
	return "envVars" in provider && Array.isArray(provider.envVars) ? provider.envVars : [];
}
function setResolvedCredentialPath(params) {
	const pathSegments = params.path.split(".").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
	if (pathSegments.length === 0) return;
	try {
		setPathExistingStrict(params.resolvedConfig, pathSegments, params.value);
	} catch {}
}
async function resolveRuntimeWebProviderSurface(params) {
	let configuredBundledPluginId = params.configuredBundledPluginIdHint;
	if (!configuredBundledPluginId && params.rawProvider) configuredBundledPluginId = (await loadResolveManifestContractOwnerPluginId())({
		contract: params.contract,
		value: params.rawProvider,
		origin: "bundled",
		config: params.sourceConfig,
		env: {
			...process.env,
			...params.context.env
		}
	});
	let allProviders = params.sortProviders(await params.resolveProviders({ configuredBundledPluginId }));
	if (params.rawProvider && params.configuredBundledPluginIdHint && configuredBundledPluginId && !allProviders.some((provider) => provider.id === params.rawProvider)) configuredBundledPluginId = void 0;
	if (params.rawProvider && !configuredBundledPluginId && !allProviders.some((provider) => provider.id === params.rawProvider)) {
		configuredBundledPluginId = (await loadResolveManifestContractOwnerPluginId())({
			contract: params.contract,
			value: params.rawProvider,
			origin: "bundled",
			config: params.sourceConfig,
			env: {
				...process.env,
				...params.context.env
			}
		});
		allProviders = params.sortProviders(await params.resolveProviders({ configuredBundledPluginId }));
	}
	const hasConfiguredSurface = Boolean(params.toolConfig) || allProviders.some((provider) => {
		if (params.ignoreKeylessProvidersForConfiguredSurface && provider.requiresCredential === false) return false;
		return params.readConfiguredCredential({
			provider,
			config: params.sourceConfig,
			toolConfig: params.toolConfig
		}) !== void 0 || params.readConfiguredCredentialFallback?.({
			provider,
			config: params.sourceConfig,
			toolConfig: params.toolConfig
		})?.value !== void 0;
	});
	const providers = hasConfiguredSurface || !params.emptyProvidersWhenSurfaceMissing ? allProviders : [];
	const configuredProvider = normalizeKnownProvider(params.rawProvider, params.normalizeConfiguredProviderAgainstActiveProviders ? providers : allProviders);
	if (params.rawProvider && !configuredProvider) {
		const diagnostic = {
			code: params.invalidAutoDetectCode,
			message: `${params.providerPath} is "${params.rawProvider}". Falling back to auto-detect precedence.`,
			path: params.providerPath
		};
		params.diagnostics.push(diagnostic);
		params.metadataDiagnostics.push(diagnostic);
		pushWarning(params.context, {
			code: params.invalidAutoDetectCode,
			path: params.providerPath,
			message: diagnostic.message
		});
	}
	return {
		providers,
		configuredProvider,
		enabled: hasConfiguredSurface && (!isRecord(params.toolConfig) || params.toolConfig.enabled !== false),
		hasConfiguredSurface
	};
}
async function resolveRuntimeWebProviderSelection(params) {
	if (params.configuredProvider) {
		params.metadata.providerConfigured = params.configuredProvider;
		params.metadata.providerSource = "configured";
	}
	if (params.enabled) {
		const candidates = params.configuredProvider ? params.providers.filter((provider) => provider.id === params.configuredProvider) : params.providers;
		const unresolvedWithoutFallback = [];
		let selectedProvider;
		let selectedResolution;
		let keylessFallbackProvider;
		for (const provider of candidates) {
			if (provider.requiresCredential === false) {
				if (params.deferKeylessFallback && !params.configuredProvider) {
					keylessFallbackProvider ||= provider;
					continue;
				}
				selectedProvider = provider.id;
				selectedResolution = {
					source: "missing",
					secretRefConfigured: false,
					fallbackUsedAfterRefFailure: false
				};
				break;
			}
			const path = params.inactivePathsForProvider(provider)[0] ?? "";
			const value = params.readConfiguredCredential({
				provider,
				config: params.sourceConfig,
				toolConfig: params.toolConfig
			});
			const resolution = await params.resolveSecretInput({
				value,
				path,
				envVars: getProviderEnvVars(provider)
			});
			let selectedCandidatePath = path;
			let selectedCandidateResolution = resolution;
			if (!resolution.value && !resolution.secretRefConfigured) {
				const fallback = params.readConfiguredCredentialFallback?.({
					provider,
					config: params.sourceConfig,
					toolConfig: params.toolConfig
				});
				if (fallback?.value !== void 0) {
					selectedCandidatePath = fallback.path;
					selectedCandidateResolution = await params.resolveSecretInput({
						value: fallback.value,
						path: fallback.path,
						envVars: getProviderEnvVars(provider)
					});
				}
			} else if (resolution.source === "env" && !resolution.secretRefConfigured) {
				const fallback = params.readConfiguredCredentialFallback?.({
					provider,
					config: params.sourceConfig,
					toolConfig: params.toolConfig
				});
				if (fallback?.value !== void 0 && params.hasConfiguredSecretRef(fallback.value, params.defaults)) {
					const fallbackResolution = await params.resolveSecretInput({
						value: fallback.value,
						path: fallback.path,
						envVars: getProviderEnvVars(provider)
					});
					if (fallbackResolution.source === "secretRef" && fallbackResolution.value) setResolvedCredentialPath({
						resolvedConfig: params.resolvedConfig,
						path: fallback.path,
						value: fallbackResolution.value
					});
				}
			}
			if (selectedCandidateResolution.secretRefConfigured && selectedCandidateResolution.fallbackUsedAfterRefFailure) {
				const diagnostic = {
					code: params.fallbackUsedCode,
					message: `${selectedCandidatePath} SecretRef could not be resolved; using ${selectedCandidateResolution.fallbackEnvVar ?? "env fallback"}. ` + (selectedCandidateResolution.unresolvedRefReason ?? "").trim(),
					path: selectedCandidatePath
				};
				params.diagnostics.push(diagnostic);
				params.metadata.diagnostics.push(diagnostic);
				pushWarning(params.context, {
					code: params.fallbackUsedCode,
					path: selectedCandidatePath,
					message: diagnostic.message
				});
			}
			if (selectedCandidateResolution.secretRefConfigured && !selectedCandidateResolution.value && selectedCandidateResolution.unresolvedRefReason) unresolvedWithoutFallback.push({
				provider: provider.id,
				path: selectedCandidatePath,
				reason: selectedCandidateResolution.unresolvedRefReason
			});
			if (params.configuredProvider) {
				selectedProvider = provider.id;
				selectedResolution = selectedCandidateResolution;
				if (selectedCandidateResolution.value) {
					setResolvedCredentialPath({
						resolvedConfig: params.resolvedConfig,
						path: selectedCandidatePath,
						value: selectedCandidateResolution.value
					});
					params.setResolvedCredential({
						resolvedConfig: params.resolvedConfig,
						provider,
						value: selectedCandidateResolution.value
					});
				}
				break;
			}
			if (selectedCandidateResolution.value) {
				selectedProvider = provider.id;
				selectedResolution = selectedCandidateResolution;
				setResolvedCredentialPath({
					resolvedConfig: params.resolvedConfig,
					path: selectedCandidatePath,
					value: selectedCandidateResolution.value
				});
				params.setResolvedCredential({
					resolvedConfig: params.resolvedConfig,
					provider,
					value: selectedCandidateResolution.value
				});
				break;
			}
		}
		if (!selectedProvider && keylessFallbackProvider) {
			selectedProvider = keylessFallbackProvider.id;
			selectedResolution = {
				source: "missing",
				secretRefConfigured: false,
				fallbackUsedAfterRefFailure: false
			};
		}
		const failUnresolvedNoFallback = (unresolved) => {
			const diagnostic = {
				code: params.noFallbackCode,
				message: unresolved.reason,
				path: unresolved.path
			};
			params.diagnostics.push(diagnostic);
			params.metadata.diagnostics.push(diagnostic);
			pushWarning(params.context, {
				code: params.noFallbackCode,
				path: unresolved.path,
				message: unresolved.reason
			});
			throw new Error(`[${params.noFallbackCode}] ${unresolved.reason}`);
		};
		if (params.configuredProvider) {
			const unresolved = unresolvedWithoutFallback[0];
			if (unresolved) failUnresolvedNoFallback(unresolved);
		} else {
			if (!selectedProvider && unresolvedWithoutFallback.length > 0) failUnresolvedNoFallback(unresolvedWithoutFallback[0]);
			if (selectedProvider) {
				const selectedDetails = params.providers.find((entry) => entry.id === selectedProvider)?.requiresCredential === false ? `${params.scopePath} auto-detected keyless provider "${selectedProvider}" as the default fallback.` : `${params.scopePath} auto-detected provider "${selectedProvider}" from available credentials.`;
				const diagnostic = {
					code: params.autoDetectSelectedCode,
					message: selectedDetails,
					path: `${params.scopePath}.provider`
				};
				params.diagnostics.push(diagnostic);
				params.metadata.diagnostics.push(diagnostic);
			}
		}
		if (selectedProvider) {
			params.metadata.selectedProvider = selectedProvider;
			params.metadata.selectedProviderKeySource = selectedResolution?.source;
			if (!params.configuredProvider) params.metadata.providerSource = "auto-detect";
			const provider = params.providers.find((entry) => entry.id === selectedProvider);
			if (provider && params.mergeRuntimeMetadata) await params.mergeRuntimeMetadata({
				provider,
				metadata: params.metadata,
				toolConfig: params.toolConfig,
				selectedResolution
			});
		}
	}
	if (params.enabled && !params.configuredProvider && params.metadata.selectedProvider) pushInactiveProviderCredentialWarnings({
		selection: params,
		skipProviderId: params.metadata.selectedProvider,
		details: `${params.scopePath} auto-detected provider is "${params.metadata.selectedProvider}".`
	});
	else if (params.toolConfig && !params.enabled) pushInactiveProviderCredentialWarnings({
		selection: params,
		details: `${params.scopePath} is disabled.`
	});
	if (params.enabled && params.toolConfig && params.configuredProvider) pushInactiveProviderCredentialWarnings({
		selection: params,
		skipProviderId: params.configuredProvider,
		details: `${params.scopePath}.provider is "${params.configuredProvider}".`
	});
}
//#endregion
//#region src/secrets/runtime-web-tools.ts
const loadRuntimeWebToolsFallbackProviders = createLazyRuntimeSurface(() => import("./runtime-web-tools-fallback.runtime.js"), ({ runtimeWebToolsFallbackProviders }) => runtimeWebToolsFallbackProviders);
const loadRuntimeWebToolsPublicArtifacts = createLazyRuntimeSurface(() => import("./runtime-web-tools-public-artifacts.runtime.js"), (mod) => mod);
const loadRuntimeWebToolsManifest = createLazyRuntimeSurface(() => import("./runtime-web-tools-manifest.runtime.js"), (mod) => mod);
const WEB_FETCH_CREDENTIAL_FIELD_NAMES = new Set([
	"apikey",
	"key",
	"token",
	"secret",
	"password"
]);
function hasCredentialBearingWebFetchValue(value, defaults, seen = /* @__PURE__ */ new WeakSet()) {
	if (hasConfiguredSecretRef(value, defaults)) return true;
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((entry) => hasCredentialBearingWebFetchValue(entry, defaults, seen));
	return Object.entries(value).some(([rawKey, entry]) => {
		const key = rawKey.toLowerCase();
		if (WEB_FETCH_CREDENTIAL_FIELD_NAMES.has(key) && entry != null && entry !== "") return true;
		return hasCredentialBearingWebFetchValue(entry, defaults, seen);
	});
}
function needsRuntimeWebFetchProviderDiscovery(params) {
	if (isRecord(params.fetch) && params.fetch.enabled === false) return false;
	if (params.hasPluginWebFetchConfig) return true;
	if (!isRecord(params.fetch)) return false;
	if (params.rawProvider) return true;
	return hasCredentialBearingWebFetchValue(params.fetch, params.defaults);
}
function hasPluginScopedWebToolConfig(config, key) {
	const entries = config.plugins?.entries;
	if (!entries) return false;
	return Object.values(entries).some((entry) => {
		if (!isRecord(entry)) return false;
		const pluginConfig = isRecord(entry.config) ? entry.config : void 0;
		return Boolean(pluginConfig?.[key]);
	});
}
function inferSingleBundledPluginScopedWebToolConfigOwner(config, key) {
	const entries = config.plugins?.entries;
	if (!entries) return;
	const matches = [];
	for (const [pluginId, entry] of Object.entries(entries)) {
		if (!isRecord(entry) || entry.enabled === false) continue;
		if (!isRecord((isRecord(entry.config) ? entry.config : void 0)?.[key])) continue;
		matches.push(pluginId);
		if (matches.length > 1) return;
	}
	return matches[0];
}
function inferExactBundledPluginScopedWebToolConfigOwner(params) {
	const entry = params.config.plugins?.entries?.[params.pluginId];
	if (!isRecord(entry) || entry.enabled === false) return;
	return isRecord((isRecord(entry.config) ? entry.config : void 0)?.[params.key]) ? params.pluginId : void 0;
}
async function hasCustomWebProviderPluginRisk(params) {
	const installRecords = loadInstalledPluginIndexInstallRecordsSync({ env: params.env });
	if (Object.keys(installRecords).length > 0) return true;
	const plugins = params.config.plugins;
	if (!plugins) return false;
	if (Array.isArray(plugins.load?.paths) && plugins.load.paths.length > 0) return true;
	const { resolveManifestContractPluginIds } = await loadRuntimeWebToolsManifest();
	const bundledPluginIds = new Set(resolveManifestContractPluginIds({
		contract: params.contract,
		origin: "bundled",
		config: params.config,
		env: params.env
	}));
	const hasNonBundledPluginId = (pluginId) => !bundledPluginIds.has(pluginId.trim());
	if (Array.isArray(plugins.allow) && plugins.allow.some(hasNonBundledPluginId)) return true;
	if (Array.isArray(plugins.deny) && plugins.deny.some(hasNonBundledPluginId)) return true;
	if (plugins.entries && Object.keys(plugins.entries).some(hasNonBundledPluginId)) return true;
	return false;
}
function readNonEmptyEnvValue(env, names) {
	for (const envVar of names) {
		const value = normalizeSecretInput(env[envVar]);
		if (value) return {
			value,
			envVar
		};
	}
	return {};
}
function buildUnresolvedReason(params) {
	if (params.kind === "non-string") return `${params.path} SecretRef resolved to a non-string value.`;
	if (params.kind === "empty") return `${params.path} SecretRef resolved to an empty value.`;
	return `${params.path} SecretRef is unresolved (${params.refLabel}).`;
}
async function resolveSecretInputWithEnvFallback(params) {
	const { ref } = resolveSecretInputRef({
		value: params.value,
		defaults: params.defaults
	});
	if (!ref) {
		const configValue = normalizeSecretInput(params.value);
		if (configValue) return {
			value: configValue,
			source: "config",
			secretRefConfigured: false,
			fallbackUsedAfterRefFailure: false
		};
		const fallback = readNonEmptyEnvValue(params.context.env, params.envVars);
		if (fallback.value) return {
			value: fallback.value,
			source: "env",
			fallbackEnvVar: fallback.envVar,
			secretRefConfigured: false,
			fallbackUsedAfterRefFailure: false
		};
		return {
			source: "missing",
			secretRefConfigured: false,
			fallbackUsedAfterRefFailure: false
		};
	}
	const refLabel = `${ref.source}:${ref.provider}:${ref.id}`;
	let resolvedFromRef;
	let unresolvedRefReason;
	if (params.restrictEnvRefsToEnvVars === true && ref.source === "env" && !params.envVars.includes(ref.id)) unresolvedRefReason = `${params.path} SecretRef env var "${ref.id}" is not allowed.`;
	else try {
		const resolvedValue = (await resolveSecretRefValues([ref], {
			config: params.sourceConfig,
			env: params.context.env,
			cache: params.context.cache
		})).get(secretRefKey(ref));
		if (typeof resolvedValue !== "string") unresolvedRefReason = buildUnresolvedReason({
			path: params.path,
			kind: "non-string",
			refLabel
		});
		else {
			resolvedFromRef = normalizeSecretInput(resolvedValue);
			if (!resolvedFromRef) unresolvedRefReason = buildUnresolvedReason({
				path: params.path,
				kind: "empty",
				refLabel
			});
		}
	} catch {
		unresolvedRefReason = buildUnresolvedReason({
			path: params.path,
			kind: "unresolved",
			refLabel
		});
	}
	if (resolvedFromRef) return {
		value: resolvedFromRef,
		source: "secretRef",
		secretRefConfigured: true,
		fallbackUsedAfterRefFailure: false
	};
	const fallback = readNonEmptyEnvValue(params.context.env, params.envVars);
	if (fallback.value) return {
		value: fallback.value,
		source: "env",
		fallbackEnvVar: fallback.envVar,
		unresolvedRefReason,
		secretRefConfigured: true,
		fallbackUsedAfterRefFailure: true
	};
	return {
		source: "missing",
		unresolvedRefReason,
		secretRefConfigured: true,
		fallbackUsedAfterRefFailure: false
	};
}
function setResolvedWebSearchApiKey(params) {
	if (params.provider.setConfiguredCredentialValue) {
		params.provider.setConfiguredCredentialValue(params.resolvedConfig, params.value);
		return;
	}
	const search = ensureObject(ensureObject(ensureObject(params.resolvedConfig, "tools"), "web"), "search");
	params.provider.setCredentialValue(search, params.value);
}
async function resolveBundledWebSearchProviders(params) {
	const env = {
		...process.env,
		...params.context.env
	};
	const onlyPluginIds = params.configuredBundledPluginId !== void 0 ? [params.configuredBundledPluginId] : params.onlyPluginIds && params.onlyPluginIds.length > 0 ? [...new Set(params.onlyPluginIds)].toSorted((left, right) => left.localeCompare(right)) : void 0;
	if (onlyPluginIds && onlyPluginIds.length > 0) {
		const bundled = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({ onlyPluginIds });
		if (bundled && bundled.length > 0) return bundled;
		const { resolvePluginWebSearchProviders } = await loadRuntimeWebToolsFallbackProviders();
		return resolvePluginWebSearchProviders({
			config: params.sourceConfig,
			env,
			bundledAllowlistCompat: true,
			onlyPluginIds,
			origin: "bundled"
		});
	}
	if (!params.hasCustomWebSearchPluginRisk) {
		const { resolveBundledWebSearchProvidersFromPublicArtifacts } = await loadRuntimeWebToolsPublicArtifacts();
		const bundled = resolveBundledWebSearchProvidersFromPublicArtifacts({
			config: params.sourceConfig,
			env,
			bundledAllowlistCompat: true
		});
		if (bundled && bundled.length > 0) return bundled;
		const { resolvePluginWebSearchProviders } = await loadRuntimeWebToolsFallbackProviders();
		return resolvePluginWebSearchProviders({
			config: params.sourceConfig,
			env,
			bundledAllowlistCompat: true,
			origin: "bundled"
		});
	}
	const { resolvePluginWebSearchProviders } = await loadRuntimeWebToolsFallbackProviders();
	return resolvePluginWebSearchProviders({
		config: params.sourceConfig,
		env,
		bundledAllowlistCompat: true
	});
}
async function resolveBundledWebFetchProviders(params) {
	const env = {
		...process.env,
		...params.context.env
	};
	if (params.configuredBundledPluginId) {
		const bundled = resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({ onlyPluginIds: [params.configuredBundledPluginId] });
		if (bundled && bundled.length > 0) return bundled;
		const { resolvePluginWebFetchProviders } = await loadRuntimeWebToolsFallbackProviders();
		return resolvePluginWebFetchProviders({
			config: params.sourceConfig,
			env,
			bundledAllowlistCompat: true,
			onlyPluginIds: [params.configuredBundledPluginId],
			origin: "bundled"
		});
	}
	if (!params.hasCustomWebFetchPluginRisk) {
		const { resolveBundledWebFetchProvidersFromPublicArtifacts } = await loadRuntimeWebToolsPublicArtifacts();
		const bundled = resolveBundledWebFetchProvidersFromPublicArtifacts({
			config: params.sourceConfig,
			env,
			bundledAllowlistCompat: true
		});
		if (bundled && bundled.length > 0) return bundled;
		const { resolvePluginWebFetchProviders } = await loadRuntimeWebToolsFallbackProviders();
		return resolvePluginWebFetchProviders({
			config: params.sourceConfig,
			env,
			bundledAllowlistCompat: true,
			origin: "bundled"
		});
	}
	const { resolvePluginWebFetchProviders } = await loadRuntimeWebToolsFallbackProviders();
	return resolvePluginWebFetchProviders({
		config: params.sourceConfig,
		env,
		bundledAllowlistCompat: true,
		origin: "bundled"
	});
}
function readConfiguredProviderCredential(params) {
	return params.provider.getConfiguredCredentialValue?.(params.config) ?? params.provider.getCredentialValue(params.search);
}
function readConfiguredProviderCredentialFallback(params) {
	return params.provider.getConfiguredCredentialFallback?.(params.config);
}
function inactivePathsForProvider(provider) {
	if (provider.requiresCredential === false) return [];
	return provider.inactiveSecretPaths?.length ? provider.inactiveSecretPaths : [provider.credentialPath];
}
function setResolvedWebFetchApiKey(params) {
	const fetch = ensureObject(ensureObject(ensureObject(params.resolvedConfig, "tools"), "web"), "fetch");
	if (params.provider.setConfiguredCredentialValue) {
		params.provider.setConfiguredCredentialValue(params.resolvedConfig, params.value);
		return;
	}
	params.provider.setCredentialValue(fetch, params.value);
}
function readConfiguredFetchProviderCredential(params) {
	return params.provider.getConfiguredCredentialValue?.(params.config) ?? params.provider.getCredentialValue(params.fetch);
}
function readConfiguredFetchProviderCredentialFallback(params) {
	return params.provider.getConfiguredCredentialFallback?.(params.config);
}
function inactivePathsForFetchProvider(provider) {
	if (provider.requiresCredential === false) return [];
	return provider.inactiveSecretPaths?.length ? provider.inactiveSecretPaths : [provider.credentialPath];
}
async function resolveRuntimeWebTools(params) {
	const defaults = params.sourceConfig.secrets?.defaults;
	const diagnostics = [];
	const env = {
		...process.env,
		...params.context.env
	};
	const sourceTools = isRecord(params.sourceConfig.tools) ? params.sourceConfig.tools : void 0;
	const sourceWeb = isRecord(sourceTools?.web) ? sourceTools.web : void 0;
	const resolvedTools = isRecord(params.resolvedConfig.tools) ? params.resolvedConfig.tools : void 0;
	const resolvedWeb = isRecord(resolvedTools?.web) ? resolvedTools.web : void 0;
	let hasCustomWebSearchRisk;
	const getHasCustomWebSearchRisk = () => {
		hasCustomWebSearchRisk ??= hasCustomWebProviderPluginRisk({
			contract: "webSearchProviders",
			config: params.sourceConfig,
			env
		});
		return hasCustomWebSearchRisk;
	};
	let hasCustomWebFetchRisk;
	const getHasCustomWebFetchRisk = () => {
		hasCustomWebFetchRisk ??= hasCustomWebProviderPluginRisk({
			contract: "webFetchProviders",
			config: params.sourceConfig,
			env
		});
		return hasCustomWebFetchRisk;
	};
	const legacyXSearchSource = isRecord(sourceWeb?.x_search) ? sourceWeb.x_search : void 0;
	const legacyXSearchResolved = isRecord(resolvedWeb?.x_search) ? resolvedWeb.x_search : void 0;
	if (legacyXSearchSource && legacyXSearchResolved && Object.prototype.hasOwnProperty.call(legacyXSearchSource, "apiKey")) {
		const legacyXSearchSourceRecord = legacyXSearchSource;
		const legacyXSearchResolvedRecord = legacyXSearchResolved;
		const resolution = await resolveSecretInputWithEnvFallback({
			sourceConfig: params.sourceConfig,
			context: params.context,
			defaults,
			value: legacyXSearchSourceRecord.apiKey,
			path: "tools.web.x_search.apiKey",
			envVars: ["XAI_API_KEY"]
		});
		if (resolution.value) legacyXSearchResolvedRecord.apiKey = resolution.value;
	}
	const hasPluginWebSearchConfig = hasPluginScopedWebToolConfig(params.sourceConfig, "webSearch");
	const hasPluginWebFetchConfig = hasPluginScopedWebToolConfig(params.sourceConfig, "webFetch");
	if (!sourceWeb && !hasPluginWebSearchConfig && !hasPluginWebFetchConfig) return {
		search: {
			providerSource: "none",
			diagnostics: []
		},
		fetch: {
			providerSource: "none",
			diagnostics: []
		},
		diagnostics
	};
	const search = isRecord(sourceWeb?.search) ? sourceWeb.search : void 0;
	const fetch = isRecord(sourceWeb?.fetch) ? sourceWeb.fetch : void 0;
	if (!search && !fetch && !hasPluginWebSearchConfig && !hasPluginWebFetchConfig) return {
		search: {
			providerSource: "none",
			diagnostics: []
		},
		fetch: {
			providerSource: "none",
			diagnostics: []
		},
		diagnostics
	};
	const rawProvider = normalizeLowercaseStringOrEmpty(search?.provider);
	let configuredBundledWebSearchPluginIdHint;
	if (hasPluginWebSearchConfig && !await getHasCustomWebSearchRisk()) {
		if (rawProvider) configuredBundledWebSearchPluginIdHint = inferExactBundledPluginScopedWebToolConfigOwner({
			config: params.sourceConfig,
			key: "webSearch",
			pluginId: rawProvider
		});
		configuredBundledWebSearchPluginIdHint ??= inferSingleBundledPluginScopedWebToolConfigOwner(params.sourceConfig, "webSearch");
	}
	const searchMetadata = {
		providerSource: "none",
		diagnostics: []
	};
	if (search || hasPluginWebSearchConfig) {
		const searchSurface = await resolveRuntimeWebProviderSurface({
			contract: "webSearchProviders",
			rawProvider,
			providerPath: "tools.web.search.provider",
			toolConfig: search,
			diagnostics,
			metadataDiagnostics: searchMetadata.diagnostics,
			invalidAutoDetectCode: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
			sourceConfig: params.sourceConfig,
			context: params.context,
			configuredBundledPluginIdHint: configuredBundledWebSearchPluginIdHint,
			resolveProviders: async ({ configuredBundledPluginId }) => resolveBundledWebSearchProviders({
				sourceConfig: params.sourceConfig,
				context: params.context,
				configuredBundledPluginId,
				hasCustomWebSearchPluginRisk: await getHasCustomWebSearchRisk()
			}),
			sortProviders: sortWebSearchProvidersForAutoDetect,
			readConfiguredCredential: ({ provider, config, toolConfig }) => readConfiguredProviderCredential({
				provider,
				config,
				search: toolConfig
			}),
			readConfiguredCredentialFallback: ({ provider, config, toolConfig }) => readConfiguredProviderCredentialFallback({
				provider,
				config,
				search: toolConfig
			}),
			ignoreKeylessProvidersForConfiguredSurface: true,
			emptyProvidersWhenSurfaceMissing: true,
			normalizeConfiguredProviderAgainstActiveProviders: true
		});
		await resolveRuntimeWebProviderSelection({
			scopePath: "tools.web.search",
			toolConfig: search,
			enabled: searchSurface.enabled,
			providers: searchSurface.providers,
			configuredProvider: searchSurface.configuredProvider,
			metadata: searchMetadata,
			diagnostics,
			sourceConfig: params.sourceConfig,
			resolvedConfig: params.resolvedConfig,
			context: params.context,
			defaults,
			deferKeylessFallback: true,
			fallbackUsedCode: "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED",
			noFallbackCode: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
			autoDetectSelectedCode: "WEB_SEARCH_AUTODETECT_SELECTED",
			readConfiguredCredential: ({ provider, config, toolConfig }) => readConfiguredProviderCredential({
				provider,
				config,
				search: toolConfig
			}),
			readConfiguredCredentialFallback: ({ provider, config, toolConfig }) => readConfiguredProviderCredentialFallback({
				provider,
				config,
				search: toolConfig
			}),
			resolveSecretInput: ({ value, path, envVars }) => resolveSecretInputWithEnvFallback({
				sourceConfig: params.sourceConfig,
				context: params.context,
				defaults,
				value,
				path,
				envVars
			}),
			setResolvedCredential: ({ resolvedConfig, provider, value }) => setResolvedWebSearchApiKey({
				resolvedConfig,
				provider,
				value
			}),
			inactivePathsForProvider,
			hasConfiguredSecretRef,
			mergeRuntimeMetadata: async ({ provider, metadata, toolConfig, selectedResolution }) => {
				if (!provider.resolveRuntimeMetadata) return;
				Object.assign(metadata, await provider.resolveRuntimeMetadata({
					config: params.sourceConfig,
					searchConfig: toolConfig,
					runtimeMetadata: metadata,
					resolvedCredential: selectedResolution ? {
						value: selectedResolution.value,
						source: selectedResolution.source,
						fallbackEnvVar: selectedResolution.fallbackEnvVar
					} : void 0
				}));
			}
		});
	}
	const rawFetchProvider = normalizeLowercaseStringOrEmpty(fetch?.provider);
	const fetchMetadata = {
		providerSource: "none",
		diagnostics: []
	};
	if (needsRuntimeWebFetchProviderDiscovery({
		fetch,
		rawProvider: rawFetchProvider,
		hasPluginWebFetchConfig,
		defaults
	})) {
		const fetchSurface = await resolveRuntimeWebProviderSurface({
			contract: "webFetchProviders",
			rawProvider: rawFetchProvider,
			providerPath: "tools.web.fetch.provider",
			toolConfig: fetch,
			diagnostics,
			metadataDiagnostics: fetchMetadata.diagnostics,
			invalidAutoDetectCode: "WEB_FETCH_PROVIDER_INVALID_AUTODETECT",
			sourceConfig: params.sourceConfig,
			context: params.context,
			resolveProviders: async ({ configuredBundledPluginId }) => resolveBundledWebFetchProviders({
				sourceConfig: params.sourceConfig,
				context: params.context,
				configuredBundledPluginId,
				hasCustomWebFetchPluginRisk: await getHasCustomWebFetchRisk()
			}),
			sortProviders: sortWebFetchProvidersForAutoDetect,
			readConfiguredCredential: ({ provider, config, toolConfig }) => readConfiguredFetchProviderCredential({
				provider,
				config,
				fetch: toolConfig
			}),
			readConfiguredCredentialFallback: ({ provider, config, toolConfig }) => readConfiguredFetchProviderCredentialFallback({
				provider,
				config,
				fetch: toolConfig
			})
		});
		await resolveRuntimeWebProviderSelection({
			scopePath: "tools.web.fetch",
			toolConfig: fetch,
			enabled: fetchSurface.enabled,
			providers: fetchSurface.providers,
			configuredProvider: fetchSurface.configuredProvider,
			metadata: fetchMetadata,
			diagnostics,
			sourceConfig: params.sourceConfig,
			resolvedConfig: params.resolvedConfig,
			context: params.context,
			defaults,
			deferKeylessFallback: false,
			fallbackUsedCode: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_FALLBACK_USED",
			noFallbackCode: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK",
			autoDetectSelectedCode: "WEB_FETCH_AUTODETECT_SELECTED",
			readConfiguredCredential: ({ provider, config, toolConfig }) => readConfiguredFetchProviderCredential({
				provider,
				config,
				fetch: toolConfig
			}),
			readConfiguredCredentialFallback: ({ provider, config, toolConfig }) => readConfiguredFetchProviderCredentialFallback({
				provider,
				config,
				fetch: toolConfig
			}),
			resolveSecretInput: ({ value, path, envVars }) => resolveSecretInputWithEnvFallback({
				sourceConfig: params.sourceConfig,
				context: params.context,
				defaults,
				value,
				path,
				envVars,
				restrictEnvRefsToEnvVars: true
			}),
			setResolvedCredential: ({ resolvedConfig, provider, value }) => setResolvedWebFetchApiKey({
				resolvedConfig,
				provider,
				value
			}),
			inactivePathsForProvider: inactivePathsForFetchProvider,
			hasConfiguredSecretRef,
			mergeRuntimeMetadata: async ({ provider, metadata, toolConfig, selectedResolution }) => {
				if (!provider.resolveRuntimeMetadata) return;
				Object.assign(metadata, await provider.resolveRuntimeMetadata({
					config: params.sourceConfig,
					fetchConfig: toolConfig,
					runtimeMetadata: metadata,
					resolvedCredential: selectedResolution ? {
						value: selectedResolution.value,
						source: selectedResolution.source,
						fallbackEnvVar: selectedResolution.fallbackEnvVar
					} : void 0
				}));
			}
		});
	}
	return {
		search: searchMetadata,
		fetch: fetchMetadata,
		diagnostics
	};
}
//#endregion
export { resolveRuntimeWebTools as t };
