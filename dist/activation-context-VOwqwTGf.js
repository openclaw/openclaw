import { n as createPluginActivationSource, s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { n as withBundledPluginEnablementCompat, r as withBundledPluginVitestCompat, t as withBundledPluginAllowlistCompat } from "./bundled-compat-BkrhFp4r.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-CuCUT4Z1.js";
//#region src/plugins/activation-context.ts
function withActivatedPluginIds(params) {
	if (params.pluginIds.length === 0) return params.config;
	const originalAllow = params.config?.plugins?.allow ?? [];
	const originalAllowSet = params.config?.plugins?.bundledDiscovery !== "compat" && originalAllow.length > 0 ? new Set(originalAllow) : void 0;
	const allow = new Set(originalAllow);
	const entries = { ...params.config?.plugins?.entries };
	for (const pluginId of params.pluginIds) {
		const normalized = pluginId.trim();
		if (!normalized) continue;
		if (originalAllowSet && !originalAllowSet.has(normalized)) continue;
		allow.add(normalized);
		const existingEntry = entries[normalized];
		entries[normalized] = {
			...existingEntry,
			enabled: existingEntry?.enabled !== false || params.overrideExplicitDisable === true
		};
	}
	const forcePluginsEnabled = params.overrideGlobalDisable === true && params.config?.plugins?.enabled === false;
	return {
		...params.config,
		plugins: {
			...params.config?.plugins,
			...forcePluginsEnabled ? { enabled: true } : {},
			...allow.size > 0 ? { allow: [...allow] } : {},
			entries
		}
	};
}
function applyPluginCompatibilityOverrides(params) {
	const allowlistCompat = params.compat?.allowlistPluginIds?.length ? withBundledPluginAllowlistCompat({
		config: params.config,
		pluginIds: params.compat.allowlistPluginIds
	}) : params.config;
	const enablementCompat = params.compat?.enablementPluginIds?.length ? withBundledPluginEnablementCompat({
		config: allowlistCompat,
		pluginIds: params.compat.enablementPluginIds
	}) : allowlistCompat;
	return params.compat?.vitestPluginIds?.length ? withBundledPluginVitestCompat({
		config: enablementCompat,
		pluginIds: params.compat.vitestPluginIds,
		env: params.env
	}) : enablementCompat;
}
function shouldResolveBundledCompatPluginIds(params) {
	return params.allowlistCompatEnabled || params.compatMode.enablement === "always" || params.compatMode.enablement === "allowlist" && params.allowlistCompatEnabled || params.compatMode.vitest === true;
}
function createBundledPluginCompatConfig(params) {
	return {
		allowlistPluginIds: params.allowlistCompatEnabled ? params.compatPluginIds : void 0,
		enablementPluginIds: params.compatMode.enablement === "always" || params.compatMode.enablement === "allowlist" && params.allowlistCompatEnabled ? params.compatPluginIds : void 0,
		vitestPluginIds: params.compatMode.vitest ? params.compatPluginIds : void 0
	};
}
function applyPluginAutoEnableForActivation(params) {
	const currentSnapshot = getCurrentPluginMetadataSnapshot({
		config: params.config,
		env: params.env,
		workspaceDir: params.workspaceDir,
		allowWorkspaceScopedSnapshot: true
	});
	const defaultDiscoverySnapshot = normalizePluginsConfig(params.config.plugins).loadPaths.length === 0 ? getCurrentPluginMetadataSnapshot({
		env: params.env,
		workspaceDir: params.workspaceDir,
		allowWorkspaceScopedSnapshot: true,
		requireDefaultDiscoveryContext: true
	}) : void 0;
	const currentManifestRegistry = currentSnapshot?.manifestRegistry ?? defaultDiscoverySnapshot?.manifestRegistry;
	return applyPluginAutoEnable({
		config: params.config,
		env: params.env,
		...currentManifestRegistry ? { manifestRegistry: currentManifestRegistry } : {}
	});
}
function resolvePluginActivationSnapshot(params) {
	const env = params.env ?? process.env;
	const rawConfig = params.rawConfig ?? params.resolvedConfig;
	let resolvedConfig = params.resolvedConfig ?? params.rawConfig;
	let autoEnabledReasons = params.autoEnabledReasons;
	if (params.applyAutoEnable && rawConfig !== void 0) {
		const autoEnabled = applyPluginAutoEnableForActivation({
			config: rawConfig,
			env,
			workspaceDir: params.workspaceDir
		});
		resolvedConfig = autoEnabled.config;
		autoEnabledReasons = autoEnabled.autoEnabledReasons;
	}
	return {
		rawConfig,
		config: resolvedConfig,
		normalized: normalizePluginsConfig(resolvedConfig?.plugins),
		activationSourceConfig: rawConfig,
		activationSource: createPluginActivationSource({ config: rawConfig }),
		autoEnabledReasons: autoEnabledReasons ?? {}
	};
}
function resolvePluginActivationInputs(params) {
	const env = params.env ?? process.env;
	const snapshot = resolvePluginActivationSnapshot({
		rawConfig: params.rawConfig,
		resolvedConfig: params.resolvedConfig,
		autoEnabledReasons: params.autoEnabledReasons,
		env,
		workspaceDir: params.workspaceDir,
		applyAutoEnable: params.applyAutoEnable
	});
	const config = applyPluginCompatibilityOverrides({
		config: snapshot.config,
		compat: params.compat,
		env
	});
	return {
		rawConfig: snapshot.rawConfig,
		config,
		normalized: normalizePluginsConfig(config?.plugins),
		activationSourceConfig: snapshot.activationSourceConfig,
		activationSource: snapshot.activationSource,
		autoEnabledReasons: snapshot.autoEnabledReasons
	};
}
function resolveBundledPluginCompatibleActivationInputs(params) {
	const snapshot = resolvePluginActivationSnapshot({
		rawConfig: params.rawConfig,
		resolvedConfig: params.resolvedConfig,
		autoEnabledReasons: params.autoEnabledReasons,
		env: params.env,
		workspaceDir: params.workspaceDir,
		applyAutoEnable: params.applyAutoEnable
	});
	const allowlistCompatEnabled = params.compatMode.allowlist === true;
	const compatPluginIds = shouldResolveBundledCompatPluginIds({
		compatMode: params.compatMode,
		allowlistCompatEnabled
	}) ? params.resolveCompatPluginIds({
		config: snapshot.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		onlyPluginIds: params.onlyPluginIds
	}) : [];
	return {
		...resolvePluginActivationInputs({
			rawConfig: snapshot.rawConfig,
			resolvedConfig: snapshot.config,
			autoEnabledReasons: snapshot.autoEnabledReasons,
			env: params.env,
			workspaceDir: params.workspaceDir,
			compat: createBundledPluginCompatConfig({
				compatMode: params.compatMode,
				allowlistCompatEnabled,
				compatPluginIds
			})
		}),
		compatPluginIds
	};
}
function resolveBundledPluginCompatibleLoadValues(params) {
	const env = params.env ?? process.env;
	const rawConfig = params.rawConfig ?? params.resolvedConfig;
	let resolvedConfig = params.resolvedConfig ?? params.rawConfig;
	let autoEnabledReasons = params.autoEnabledReasons ?? {};
	if (params.applyAutoEnable && rawConfig !== void 0) {
		const autoEnabled = applyPluginAutoEnableForActivation({
			config: rawConfig,
			env,
			workspaceDir: params.workspaceDir
		});
		resolvedConfig = autoEnabled.config;
		autoEnabledReasons = autoEnabled.autoEnabledReasons;
	}
	const allowlistCompatEnabled = params.compatMode.allowlist === true;
	const compatPluginIds = shouldResolveBundledCompatPluginIds({
		compatMode: params.compatMode,
		allowlistCompatEnabled
	}) ? params.resolveCompatPluginIds({
		config: resolvedConfig,
		workspaceDir: params.workspaceDir,
		env,
		onlyPluginIds: params.onlyPluginIds
	}) : [];
	return {
		rawConfig,
		config: applyPluginCompatibilityOverrides({
			config: resolvedConfig,
			compat: createBundledPluginCompatConfig({
				compatMode: params.compatMode,
				allowlistCompatEnabled,
				compatPluginIds
			}),
			env
		}),
		activationSourceConfig: rawConfig,
		autoEnabledReasons,
		compatPluginIds
	};
}
//#endregion
export { resolveBundledPluginCompatibleLoadValues as n, withActivatedPluginIds as r, resolveBundledPluginCompatibleActivationInputs as t };
