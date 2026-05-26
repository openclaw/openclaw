import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as mergePluginTextTransforms } from "./plugin-text-transforms-jHXsIkoa.js";
import { r as resolvePluginSetupCliBackend } from "./setup-registry-DHllMAAd.js";
import { t as resolveRuntimeTextTransforms } from "./text-transforms.runtime.js";
import { n as resolveRuntimeCliBackends } from "./model-selection-cli-DS-HhXIv.js";
import "./model-selection-P-81eBKx.js";
let cliBackendsDeps = {
	resolvePluginSetupCliBackend,
	resolveRuntimeCliBackends
};
const FALLBACK_CLI_BACKEND_POLICIES = {};
function normalizeBundleMcpMode(mode, enabled) {
	if (!enabled) return;
	return mode ?? "claude-config-file";
}
function resolveSetupCliBackendPolicy(provider) {
	const entry = cliBackendsDeps.resolvePluginSetupCliBackend({ backend: provider });
	if (!entry) return;
	return {
		bundleMcp: entry.backend.bundleMcp === true,
		bundleMcpMode: normalizeBundleMcpMode(entry.backend.bundleMcpMode, entry.backend.bundleMcp === true),
		baseConfig: entry.backend.config,
		normalizeConfig: entry.backend.normalizeConfig,
		transformSystemPrompt: entry.backend.transformSystemPrompt,
		textTransforms: entry.backend.textTransforms,
		defaultAuthProfileId: entry.backend.defaultAuthProfileId,
		authEpochMode: entry.backend.authEpochMode,
		contextEngineHostCapabilities: entry.backend.contextEngineHostCapabilities,
		prepareExecution: entry.backend.prepareExecution,
		resolveExecutionArgs: entry.backend.resolveExecutionArgs,
		nativeToolMode: entry.backend.nativeToolMode
	};
}
function resolveFallbackCliBackendPolicy(provider) {
	return FALLBACK_CLI_BACKEND_POLICIES[provider] ?? resolveSetupCliBackendPolicy(provider);
}
function normalizeBackendKey(key) {
	return normalizeProviderId(key);
}
function pickBackendConfig(config, normalizedId) {
	const directKey = Object.keys(config).find((key) => normalizeOptionalLowercaseString(key) === normalizedId);
	if (directKey) return config[directKey];
	for (const [key, entry] of Object.entries(config)) if (normalizeBackendKey(key) === normalizedId) return entry;
}
function resolveRegisteredBackend(provider) {
	const normalized = normalizeBackendKey(provider);
	return cliBackendsDeps.resolveRuntimeCliBackends().find((entry) => normalizeBackendKey(entry.id) === normalized);
}
function mergeBackendConfig(base, override) {
	if (!override) return { ...base };
	const baseFresh = base.reliability?.watchdog?.fresh ?? {};
	const baseResume = base.reliability?.watchdog?.resume ?? {};
	const baseOutputLimits = base.reliability?.outputLimits ?? {};
	const overrideFresh = override.reliability?.watchdog?.fresh ?? {};
	const overrideResume = override.reliability?.watchdog?.resume ?? {};
	const overrideOutputLimits = override.reliability?.outputLimits ?? {};
	return {
		...base,
		...override,
		args: override.args ?? base.args,
		env: {
			...base.env,
			...override.env
		},
		modelAliases: {
			...base.modelAliases,
			...override.modelAliases
		},
		clearEnv: Array.from(new Set([...base.clearEnv ?? [], ...override.clearEnv ?? []])),
		sessionIdFields: override.sessionIdFields ?? base.sessionIdFields,
		sessionArgs: override.sessionArgs ?? base.sessionArgs,
		resumeArgs: override.resumeArgs ?? base.resumeArgs,
		reliability: {
			...base.reliability,
			...override.reliability,
			outputLimits: {
				...baseOutputLimits,
				...overrideOutputLimits
			},
			watchdog: {
				...base.reliability?.watchdog,
				...override.reliability?.watchdog,
				fresh: {
					...baseFresh,
					...overrideFresh
				},
				resume: {
					...baseResume,
					...overrideResume
				}
			}
		}
	};
}
function resolveCliBackendConfig(provider, cfg, options = {}) {
	const normalized = normalizeBackendKey(provider);
	const normalizeContext = {
		backendId: normalized,
		...options.agentId ? { agentId: options.agentId } : {},
		...cfg ? { config: cfg } : {}
	};
	const runtimeTextTransforms = resolveRuntimeTextTransforms();
	const override = pickBackendConfig(cfg?.agents?.defaults?.cliBackends ?? {}, normalized);
	const registered = resolveRegisteredBackend(normalized);
	if (registered) {
		const merged = mergeBackendConfig(registered.config, override);
		const config = registered.normalizeConfig ? registered.normalizeConfig(merged, normalizeContext) : merged;
		const command = config.command?.trim();
		if (!command) return null;
		return {
			id: normalized,
			config: {
				...config,
				command
			},
			bundleMcp: registered.bundleMcp === true,
			bundleMcpMode: normalizeBundleMcpMode(registered.bundleMcpMode, registered.bundleMcp === true),
			pluginId: registered.pluginId,
			transformSystemPrompt: registered.transformSystemPrompt,
			textTransforms: mergePluginTextTransforms(runtimeTextTransforms, registered.textTransforms),
			defaultAuthProfileId: registered.defaultAuthProfileId,
			authEpochMode: registered.authEpochMode,
			contextEngineHostCapabilities: registered.contextEngineHostCapabilities,
			prepareExecution: registered.prepareExecution,
			resolveExecutionArgs: registered.resolveExecutionArgs,
			nativeToolMode: registered.nativeToolMode
		};
	}
	const fallbackPolicy = resolveFallbackCliBackendPolicy(normalized);
	if (!override) {
		if (!fallbackPolicy?.baseConfig) return null;
		const baseConfig = fallbackPolicy.normalizeConfig ? fallbackPolicy.normalizeConfig(fallbackPolicy.baseConfig, normalizeContext) : fallbackPolicy.baseConfig;
		const command = baseConfig.command?.trim();
		if (!command) return null;
		return {
			id: normalized,
			config: {
				...baseConfig,
				command
			},
			bundleMcp: fallbackPolicy.bundleMcp,
			bundleMcpMode: fallbackPolicy.bundleMcpMode,
			transformSystemPrompt: fallbackPolicy.transformSystemPrompt,
			textTransforms: mergePluginTextTransforms(runtimeTextTransforms, fallbackPolicy.textTransforms),
			defaultAuthProfileId: fallbackPolicy.defaultAuthProfileId,
			authEpochMode: fallbackPolicy.authEpochMode,
			contextEngineHostCapabilities: fallbackPolicy.contextEngineHostCapabilities,
			prepareExecution: fallbackPolicy.prepareExecution,
			resolveExecutionArgs: fallbackPolicy.resolveExecutionArgs,
			nativeToolMode: fallbackPolicy.nativeToolMode
		};
	}
	const mergedFallback = fallbackPolicy?.baseConfig ? mergeBackendConfig(fallbackPolicy.baseConfig, override) : override;
	const config = fallbackPolicy?.normalizeConfig ? fallbackPolicy.normalizeConfig(mergedFallback, normalizeContext) : mergedFallback;
	const command = config.command?.trim();
	if (!command) return null;
	return {
		id: normalized,
		config: {
			...config,
			command
		},
		bundleMcp: fallbackPolicy?.bundleMcp === true,
		bundleMcpMode: fallbackPolicy?.bundleMcpMode,
		transformSystemPrompt: fallbackPolicy?.transformSystemPrompt,
		textTransforms: mergePluginTextTransforms(runtimeTextTransforms, fallbackPolicy?.textTransforms),
		defaultAuthProfileId: fallbackPolicy?.defaultAuthProfileId,
		authEpochMode: fallbackPolicy?.authEpochMode,
		contextEngineHostCapabilities: fallbackPolicy?.contextEngineHostCapabilities,
		prepareExecution: fallbackPolicy?.prepareExecution,
		resolveExecutionArgs: fallbackPolicy?.resolveExecutionArgs,
		nativeToolMode: fallbackPolicy?.nativeToolMode
	};
}
//#endregion
export { resolveCliBackendConfig as t };
