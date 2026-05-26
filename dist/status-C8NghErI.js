import { n as buildPluginDependencyStatus, o as tracePluginLifecyclePhase } from "./discovery-BEbYTYvv.js";
import { o as resolveCompatibilityHostVersion } from "./version-B2G3zXnp.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default-Cg5lIU6L.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { r as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-DlaHO4z7.js";
import { r as hasKind } from "./slots-DLJ2h3Qv.js";
import { s as normalizePluginsConfig } from "./config-state-BgyjpLHd.js";
import { m as loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-Cdr1zbpf.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { n as withBundledPluginEnablementCompat, t as withBundledPluginAllowlistCompat } from "./bundled-compat-Dfs9mbab.js";
import { n as normalizeOpenClawVersionBase } from "./version-Du8fTz5t.js";
import "./config-CzeRK-GW.js";
import { s as resolveBundledProviderCompatPluginIds } from "./plugin-auto-enable-DLIxCAM0.js";
import { l as loadOpenClawPlugins } from "./loader-DkTFEskE.js";
import { n as inspectBundleMcpRuntimeSupport } from "./bundle-mcp-CFLIOQBM.js";
import { I as createEmptyPluginRegistry, u as listImportedRuntimePluginIds } from "./runtime-CFKT2mp_.js";
import { n as listImportedBundledPluginFacadeIds } from "./facade-loader-BqRX3EBI.js";
import "./facade-runtime-BJdBwhen.js";
import { i as resolvePluginRuntimeLoadContext, t as buildPluginRuntimeLoadOptions } from "./load-context-44_qDmo1.js";
import "./workspace-BNTZ_9-b.js";
import { t as inspectBundleLspRuntimeSupport } from "./bundle-lsp-BaroKwwx.js";
import { t as resolveEffectivePluginIds } from "./effective-plugin-ids-4986rx4V.js";
import { t as loadPluginMetadataRegistrySnapshot } from "./metadata-registry-loader-Dfsf7LET.js";
//#region src/plugins/inspect-shape.ts
function buildPluginCapabilityEntries(plugin) {
	return [
		{
			kind: "cli-backend",
			ids: plugin.cliBackendIds ?? []
		},
		{
			kind: "text-inference",
			ids: plugin.providerIds
		},
		{
			kind: "speech",
			ids: plugin.speechProviderIds
		},
		{
			kind: "realtime-transcription",
			ids: plugin.realtimeTranscriptionProviderIds
		},
		{
			kind: "realtime-voice",
			ids: plugin.realtimeVoiceProviderIds
		},
		{
			kind: "media-understanding",
			ids: plugin.mediaUnderstandingProviderIds
		},
		{
			kind: "image-generation",
			ids: plugin.imageGenerationProviderIds
		},
		{
			kind: "web-search",
			ids: plugin.webSearchProviderIds
		},
		{
			kind: "agent-harness",
			ids: plugin.agentHarnessIds
		},
		{
			kind: "context-engine",
			ids: plugin.status === "loaded" && hasKind(plugin.kind, "context-engine") ? plugin.contextEngineIds ?? [] : []
		},
		{
			kind: "channel",
			ids: plugin.channelIds
		}
	].filter((entry) => entry.ids.length > 0);
}
function derivePluginInspectShape(params) {
	if (params.capabilityCount > 1) return "hybrid-capability";
	if (params.capabilityCount === 1) return "plain-capability";
	if (params.typedHookCount + params.customHookCount > 0 && params.toolCount === 0 && params.commandCount === 0 && params.cliCount === 0 && params.serviceCount === 0 && params.gatewayDiscoveryServiceCount === 0 && params.gatewayMethodCount === 0 && params.httpRouteCount === 0) return "hook-only";
	return "non-capability";
}
function buildPluginShapeSummary(params) {
	const capabilities = buildPluginCapabilityEntries(params.plugin);
	const typedHookCount = params.report.typedHooks.filter((entry) => entry.pluginId === params.plugin.id).length;
	const customHookCount = params.report.hooks.filter((entry) => entry.pluginId === params.plugin.id).length;
	const toolCount = params.report.tools.filter((entry) => entry.pluginId === params.plugin.id).length;
	const capabilityCount = capabilities.length;
	return {
		shape: derivePluginInspectShape({
			capabilityCount,
			typedHookCount,
			customHookCount,
			toolCount,
			commandCount: params.plugin.commands.length,
			cliCount: params.plugin.cliCommands.length,
			serviceCount: params.plugin.services.length,
			gatewayDiscoveryServiceCount: params.plugin.gatewayDiscoveryServiceIds.length,
			gatewayMethodCount: params.plugin.gatewayMethods.length,
			httpRouteCount: params.plugin.httpRoutes
		}),
		capabilityMode: capabilityCount === 0 ? "none" : capabilityCount === 1 ? "plain" : "hybrid",
		capabilityCount,
		capabilities,
		usesLegacyBeforeAgentStart: params.report.typedHooks.some((entry) => entry.pluginId === params.plugin.id && entry.hookName === "before_agent_start")
	};
}
//#endregion
//#region src/plugins/status.ts
function buildCompatibilityNoticesForInspect(inspect) {
	const warnings = [];
	if (inspect.usesLegacyBeforeAgentStart) warnings.push({
		pluginId: inspect.plugin.id,
		code: "legacy-before-agent-start",
		compatCode: "legacy-before-agent-start",
		severity: "warn",
		message: "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work."
	});
	if (inspect.shape === "hook-only") warnings.push({
		pluginId: inspect.plugin.id,
		code: "hook-only",
		compatCode: "hook-only-plugin-shape",
		severity: "info",
		message: "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet."
	});
	return warnings;
}
function resolveReportedPluginVersion(plugin, env) {
	if (plugin.origin !== "bundled") return plugin.version;
	return normalizeOpenClawVersionBase(resolveCompatibilityHostVersion(env)) ?? normalizeOpenClawVersionBase(plugin.version) ?? plugin.version;
}
function buildPluginRecordFromInstalledIndex(plugin, manifest) {
	const format = plugin.format ?? manifest?.format ?? "openclaw";
	const bundleFormat = plugin.bundleFormat ?? manifest?.bundleFormat;
	return {
		id: plugin.pluginId,
		name: manifest?.name ?? plugin.packageName ?? plugin.pluginId,
		...plugin.packageVersion || manifest?.version ? { version: plugin.packageVersion ?? manifest?.version } : {},
		...manifest?.description ? { description: manifest.description } : {},
		format,
		...bundleFormat ? { bundleFormat } : {},
		...manifest?.kind ? { kind: manifest.kind } : {},
		source: plugin.source ?? plugin.manifestPath,
		rootDir: plugin.rootDir,
		origin: plugin.origin,
		enabled: plugin.enabled,
		compat: plugin.compat,
		syntheticAuthRefs: [...plugin.syntheticAuthRefs ?? manifest?.syntheticAuthRefs ?? []],
		status: plugin.enabled ? "loaded" : "disabled",
		toolNames: [],
		hookNames: [],
		channelIds: [...manifest?.channels ?? []],
		cliBackendIds: [...manifest?.cliBackends ?? [], ...manifest?.setup?.cliBackends ?? []],
		providerIds: [...manifest?.providers ?? []],
		speechProviderIds: [...manifest?.contracts?.speechProviders ?? []],
		realtimeTranscriptionProviderIds: [...manifest?.contracts?.realtimeTranscriptionProviders ?? []],
		realtimeVoiceProviderIds: [...manifest?.contracts?.realtimeVoiceProviders ?? []],
		mediaUnderstandingProviderIds: [...manifest?.contracts?.mediaUnderstandingProviders ?? []],
		imageGenerationProviderIds: [...manifest?.contracts?.imageGenerationProviders ?? []],
		videoGenerationProviderIds: [...manifest?.contracts?.videoGenerationProviders ?? []],
		musicGenerationProviderIds: [...manifest?.contracts?.musicGenerationProviders ?? []],
		webFetchProviderIds: [...manifest?.contracts?.webFetchProviders ?? []],
		webSearchProviderIds: [...manifest?.contracts?.webSearchProviders ?? []],
		migrationProviderIds: [...manifest?.contracts?.migrationProviders ?? []],
		memoryEmbeddingProviderIds: [...manifest?.contracts?.memoryEmbeddingProviders ?? []],
		agentHarnessIds: [],
		gatewayMethods: [],
		cliCommands: [],
		services: [],
		gatewayDiscoveryServiceIds: [],
		commands: [...manifest?.commandAliases?.map((alias) => alias.name) ?? []],
		httpRoutes: 0,
		hookCount: 0,
		configSchema: false,
		contracts: {},
		dependencyStatus: buildPluginDependencyStatus({
			rootDir: plugin.rootDir,
			dependencies: manifest?.packageDependencies,
			optionalDependencies: manifest?.packageOptionalDependencies
		})
	};
}
function buildPluginRegistrySnapshotReport(params) {
	const config = params?.config ?? getRuntimeConfig();
	const result = tracePluginLifecyclePhase("plugin registry snapshot", () => loadPluginRegistrySnapshotWithMetadata({
		config,
		env: params?.env,
		workspaceDir: params?.workspaceDir
	}), { surface: "status" });
	const manifestByPluginId = loadPluginMetadataSnapshot({
		index: result.snapshot,
		config,
		env: params?.env ?? process.env,
		workspaceDir: params?.workspaceDir
	}).byPluginId;
	return {
		workspaceDir: params?.workspaceDir,
		...createEmptyPluginRegistry(),
		plugins: result.snapshot.plugins.map((plugin) => buildPluginRecordFromInstalledIndex(plugin, manifestByPluginId.get(plugin.pluginId))),
		diagnostics: [...result.snapshot.diagnostics],
		registrySource: result.source,
		registryDiagnostics: result.diagnostics
	};
}
function buildPluginReport(params, loadModules) {
	const rawConfig = params?.config ?? getRuntimeConfig();
	const initialWorkspaceDir = params?.workspaceDir ?? resolveAgentWorkspaceDir(rawConfig, resolveDefaultAgentId(rawConfig), params?.env);
	const metadataSnapshot = !loadModules ? loadPluginMetadataSnapshot({
		config: rawConfig,
		env: params?.env ?? process.env,
		workspaceDir: initialWorkspaceDir
	}) : void 0;
	const baseContext = resolvePluginRuntimeLoadContext({
		config: rawConfig,
		env: params?.env,
		logger: params?.logger,
		workspaceDir: initialWorkspaceDir,
		manifestRegistry: metadataSnapshot?.manifestRegistry
	});
	const workspaceDir = baseContext.workspaceDir ?? initialWorkspaceDir ?? resolveDefaultAgentWorkspaceDir();
	const context = workspaceDir === baseContext.workspaceDir ? baseContext : {
		...baseContext,
		workspaceDir
	};
	const config = context.config;
	const bundledProviderIds = resolveBundledProviderCompatPluginIds({
		config,
		workspaceDir,
		env: params?.env,
		manifestRegistry: metadataSnapshot?.manifestRegistry
	});
	const runtimeCompatConfig = withBundledPluginEnablementCompat({
		config: withBundledPluginAllowlistCompat({
			config,
			pluginIds: bundledProviderIds
		}),
		pluginIds: bundledProviderIds
	});
	const onlyPluginIds = params?.effectiveOnly === true ? resolveEffectivePluginIds({
		config: rawConfig,
		workspaceDir,
		env: params?.env ?? process.env
	}) : params?.onlyPluginIds === void 0 ? void 0 : [...params.onlyPluginIds];
	const registry = loadModules ? tracePluginLifecyclePhase("runtime plugin registry load", () => loadOpenClawPlugins(buildPluginRuntimeLoadOptions(context, {
		config: runtimeCompatConfig,
		activationSourceConfig: rawConfig,
		workspaceDir,
		env: params?.env,
		loadModules,
		activate: false,
		cache: false,
		onlyPluginIds
	})), {
		surface: "status",
		onlyPluginCount: onlyPluginIds?.length
	}) : tracePluginLifecyclePhase("plugin registry snapshot", () => loadPluginMetadataRegistrySnapshot({
		config: runtimeCompatConfig,
		activationSourceConfig: rawConfig,
		workspaceDir,
		env: params?.env,
		logger: params?.logger,
		loadModules: false,
		onlyPluginIds,
		manifestRegistry: metadataSnapshot?.manifestRegistry,
		runtimeContext: context
	}), {
		surface: "status",
		onlyPluginCount: onlyPluginIds?.length
	});
	const importedPluginIds = new Set([
		...loadModules ? registry.plugins.filter((plugin) => plugin.status === "loaded" && plugin.format !== "bundle").map((plugin) => plugin.id) : [],
		...listImportedRuntimePluginIds(),
		...listImportedBundledPluginFacadeIds()
	]);
	return {
		workspaceDir,
		...registry,
		plugins: registry.plugins.map((plugin) => Object.assign({}, plugin, {
			imported: plugin.format !== `bundle` && importedPluginIds.has(plugin.id),
			version: resolveReportedPluginVersion(plugin, params?.env),
			dependencyStatus: plugin.dependencyStatus ?? buildPluginDependencyStatus({
				rootDir: plugin.rootDir,
				dependencies: metadataSnapshot?.byPluginId.get(plugin.id)?.packageDependencies,
				optionalDependencies: metadataSnapshot?.byPluginId.get(plugin.id)?.packageOptionalDependencies
			})
		}))
	};
}
function buildPluginSnapshotReport(params) {
	return buildPluginReport(params, false);
}
function buildPluginDiagnosticsReport(params) {
	return buildPluginReport(params, true);
}
function buildPluginInspectReport(params) {
	const rawConfig = params.config ?? getRuntimeConfig();
	const config = params.resolvedConfig ?? resolvePluginRuntimeLoadContext({
		config: rawConfig,
		env: params.env,
		logger: params.logger,
		workspaceDir: params.workspaceDir
	}).config;
	const report = params.report ?? buildPluginDiagnosticsReport({
		config: rawConfig,
		logger: params.logger,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const plugin = report.plugins.find((entry) => entry.id === params.id || entry.name === params.id);
	if (!plugin) return null;
	const typedHooks = report.typedHooks.filter((entry) => entry.pluginId === plugin.id).map((entry) => ({
		name: entry.hookName,
		priority: entry.priority
	})).toSorted((a, b) => a.name.localeCompare(b.name));
	const customHooks = report.hooks.filter((entry) => entry.pluginId === plugin.id).map((entry) => ({
		name: entry.entry.hook.name,
		events: [...entry.events].toSorted()
	})).toSorted((a, b) => a.name.localeCompare(b.name));
	const tools = report.tools.filter((entry) => entry.pluginId === plugin.id).map((entry) => ({
		names: [...entry.names],
		optional: entry.optional
	}));
	const diagnostics = report.diagnostics.filter((entry) => entry.pluginId === plugin.id);
	const policyEntry = normalizePluginsConfig(config.plugins).entries[plugin.id];
	const shapeSummary = buildPluginShapeSummary({
		plugin,
		report
	});
	const shape = shapeSummary.shape;
	let mcpServers = [];
	if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
		const mcpSupport = inspectBundleMcpRuntimeSupport({
			pluginId: plugin.id,
			rootDir: plugin.rootDir,
			bundleFormat: plugin.bundleFormat
		});
		mcpServers = [...mcpSupport.supportedServerNames.map((name) => ({
			name,
			hasStdioTransport: true
		})), ...mcpSupport.unsupportedServerNames.map((name) => ({
			name,
			hasStdioTransport: false
		}))];
	}
	let lspServers = [];
	if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
		const lspSupport = inspectBundleLspRuntimeSupport({
			pluginId: plugin.id,
			rootDir: plugin.rootDir,
			bundleFormat: plugin.bundleFormat
		});
		lspServers = [...lspSupport.supportedServerNames.map((name) => ({
			name,
			hasStdioTransport: true
		})), ...lspSupport.unsupportedServerNames.map((name) => ({
			name,
			hasStdioTransport: false
		}))];
	}
	const usesLegacyBeforeAgentStart = shapeSummary.usesLegacyBeforeAgentStart;
	const compatibility = buildCompatibilityNoticesForInspect({
		plugin,
		shape,
		usesLegacyBeforeAgentStart
	});
	return {
		workspaceDir: report.workspaceDir,
		plugin,
		shape,
		capabilityMode: shapeSummary.capabilityMode,
		capabilityCount: shapeSummary.capabilityCount,
		capabilities: shapeSummary.capabilities,
		typedHooks,
		customHooks,
		tools,
		commands: [...plugin.commands],
		cliCommands: [...plugin.cliCommands],
		services: [...plugin.services],
		gatewayDiscoveryServices: [...plugin.gatewayDiscoveryServiceIds],
		gatewayMethods: [...plugin.gatewayMethods],
		mcpServers,
		lspServers,
		httpRouteCount: plugin.httpRoutes,
		bundleCapabilities: plugin.bundleCapabilities ?? [],
		diagnostics,
		policy: {
			allowPromptInjection: policyEntry?.hooks?.allowPromptInjection,
			allowConversationAccess: policyEntry?.hooks?.allowConversationAccess,
			hookTimeoutMs: policyEntry?.hooks?.timeoutMs,
			hookTimeouts: policyEntry?.hooks?.timeouts ? { ...policyEntry.hooks.timeouts } : void 0,
			allowModelOverride: policyEntry?.subagent?.allowModelOverride,
			allowedModels: [...policyEntry?.subagent?.allowedModels ?? []],
			hasAllowedModelsConfig: policyEntry?.subagent?.hasAllowedModelsConfig === true
		},
		usesLegacyBeforeAgentStart,
		compatibility
	};
}
function buildAllPluginInspectReports(params) {
	const rawConfig = params?.config ?? getRuntimeConfig();
	const config = resolvePluginRuntimeLoadContext({
		config: rawConfig,
		env: params?.env,
		logger: params?.logger,
		workspaceDir: params?.workspaceDir
	}).config;
	const report = params?.report ?? buildPluginDiagnosticsReport({
		config: rawConfig,
		logger: params?.logger,
		workspaceDir: params?.workspaceDir,
		env: params?.env
	});
	return report.plugins.map((plugin) => buildPluginInspectReport({
		id: plugin.id,
		config: rawConfig,
		logger: params?.logger,
		workspaceDir: params?.workspaceDir,
		env: params?.env,
		resolvedConfig: config,
		report
	})).filter((entry) => entry !== null);
}
function buildPluginCompatibilityWarnings(params) {
	return buildPluginCompatibilityNotices(params).map(formatPluginCompatibilityNotice);
}
function buildPluginCompatibilityNotices(params) {
	return buildAllPluginInspectReports(params).flatMap((inspect) => inspect.compatibility);
}
function buildPluginCompatibilitySnapshotNotices(params) {
	const report = buildPluginSnapshotReport(params);
	return buildPluginCompatibilityNotices({
		...params,
		report
	});
}
function formatPluginCompatibilityNotice(notice) {
	return `${notice.pluginId} ${notice.message}`;
}
function summarizePluginCompatibility(notices) {
	return {
		noticeCount: notices.length,
		pluginCount: new Set(notices.map((notice) => notice.pluginId)).size
	};
}
//#endregion
export { buildPluginDiagnosticsReport as a, buildPluginSnapshotReport as c, buildPluginCompatibilityWarnings as i, formatPluginCompatibilityNotice as l, buildPluginCompatibilityNotices as n, buildPluginInspectReport as o, buildPluginCompatibilitySnapshotNotices as r, buildPluginRegistrySnapshotReport as s, buildAllPluginInspectReports as t, summarizePluginCompatibility as u };
