import { i as normalizePluginIdScope, n as hasExplicitPluginIdScope } from "./plugin-scope-6HF2N6kz.js";
import { r as withActivatedPluginIds } from "./activation-context-VOwqwTGf.js";
import { c as loadOpenClawPlugins, o as isPluginRegistryLoadInFlight } from "./loader-DKK7Ita0.js";
import { c as getActivePluginRegistryWorkspaceDir } from "./runtime-DHxRl5F1.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
import { n as buildPluginRuntimeLoadOptionsFromValues, r as createPluginRuntimeLoaderLogger } from "./load-context-BO-9CJts.js";
//#region src/plugins/web-provider-runtime-shared.ts
function resolveWebProviderRuntimeContext(params, deps) {
	const env = params.env ?? process.env;
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
	const shouldFilterProviders = params.config !== void 0 || params.onlyPluginIds !== void 0 || params.origin !== void 0 || params.bundledAllowlistCompat === true;
	const { config, activationSourceConfig, autoEnabledReasons } = deps.resolveBundledResolutionConfig({
		...params,
		workspaceDir,
		env
	});
	const candidatePluginIds = normalizePluginIdScope(deps.resolveCandidatePluginIds({
		config,
		workspaceDir,
		env,
		onlyPluginIds: params.onlyPluginIds,
		origin: params.origin
	}));
	return {
		activationSourceConfig,
		autoEnabledReasons,
		config,
		env,
		loadPluginIds: candidatePluginIds,
		onlyPluginIds: shouldFilterProviders ? candidatePluginIds : void 0,
		workspaceDir
	};
}
function resolveWebProviderLoadOptions(context, params) {
	return buildPluginRuntimeLoadOptionsFromValues({
		env: context.env,
		config: context.config,
		activationSourceConfig: context.activationSourceConfig,
		autoEnabledReasons: context.autoEnabledReasons,
		workspaceDir: context.workspaceDir,
		logger: createPluginRuntimeLoaderLogger()
	}, {
		cache: params.cache ?? true,
		activate: params.activate ?? false,
		...hasExplicitPluginIdScope(context.loadPluginIds) ? { onlyPluginIds: context.loadPluginIds } : {}
	});
}
function resolveRuntimeRegistryWebProviders(params) {
	if (!params.registry) return;
	const providers = params.mapRegistryProviders({
		registry: params.registry,
		onlyPluginIds: params.onlyPluginIds
	});
	return {
		providers,
		shouldReturn: providers.length > 0 || params.hasExplicitEmptyScope
	};
}
function resolvePluginWebProviders(params, deps) {
	const env = params.env ?? process.env;
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
	if (params.mode === "setup") {
		const pluginIds = deps.resolveCandidatePluginIds({
			config: params.config,
			workspaceDir,
			env,
			onlyPluginIds: params.onlyPluginIds,
			origin: params.origin
		}) ?? [];
		if (pluginIds.length === 0) return [];
		if (params.activate !== true) {
			const bundledArtifactProviders = deps.resolveBundledPublicArtifactProviders?.({
				config: params.config,
				workspaceDir,
				env,
				bundledAllowlistCompat: params.bundledAllowlistCompat,
				onlyPluginIds: pluginIds
			});
			if (bundledArtifactProviders) return bundledArtifactProviders;
		}
		const registry = loadOpenClawPlugins(buildPluginRuntimeLoadOptionsFromValues({
			config: withActivatedPluginIds({
				config: params.config,
				pluginIds
			}),
			activationSourceConfig: params.config,
			autoEnabledReasons: {},
			workspaceDir,
			env,
			logger: createPluginRuntimeLoaderLogger()
		}, {
			onlyPluginIds: pluginIds,
			cache: params.cache ?? true,
			activate: params.activate ?? false
		}));
		return deps.mapRegistryProviders({
			registry,
			onlyPluginIds: pluginIds
		});
	}
	const context = resolveWebProviderRuntimeContext(params, deps);
	const loadOptions = resolveWebProviderLoadOptions(context, params);
	const compatible = getLoadedRuntimePluginRegistry({
		env: context.env,
		loadOptions,
		workspaceDir: context.workspaceDir,
		requiredPluginIds: context.loadPluginIds
	});
	const scopedPluginIds = context.onlyPluginIds;
	const hasExplicitEmptyScope = scopedPluginIds !== void 0 && scopedPluginIds.length === 0;
	const compatibleProviders = resolveRuntimeRegistryWebProviders({
		hasExplicitEmptyScope,
		mapRegistryProviders: deps.mapRegistryProviders,
		onlyPluginIds: context.onlyPluginIds,
		registry: compatible
	});
	if (compatibleProviders?.shouldReturn) return compatibleProviders.providers;
	if (compatibleProviders) {}
	if (isPluginRegistryLoadInFlight(loadOptions)) return [];
	if (hasExplicitEmptyScope) return [];
	const registry = loadOpenClawPlugins(loadOptions);
	return deps.mapRegistryProviders({
		registry,
		onlyPluginIds: context.onlyPluginIds
	});
}
function resolveRuntimeWebProviders(params, deps) {
	const runtimeRegistry = getLoadedRuntimePluginRegistry({
		env: params.env,
		workspaceDir: params.workspaceDir,
		requiredPluginIds: params.onlyPluginIds
	});
	const runtimeProviders = resolveRuntimeRegistryWebProviders({
		hasExplicitEmptyScope: params.onlyPluginIds !== void 0 && params.onlyPluginIds.length === 0,
		mapRegistryProviders: deps.mapRegistryProviders,
		onlyPluginIds: params.onlyPluginIds,
		registry: runtimeRegistry
	});
	if (runtimeProviders?.shouldReturn) return runtimeProviders.providers;
	return resolvePluginWebProviders(params, deps);
}
//#endregion
export { resolveRuntimeWebProviders as n, resolvePluginWebProviders as t };
