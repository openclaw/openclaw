import "./hook-runner-global-BkXXy1ub.js";
//#region src/plugins/status.test-helpers.ts
function createPluginRecord(overrides) {
	const { id, ...rest } = overrides;
	return {
		id,
		name: overrides.name ?? id,
		description: overrides.description ?? "",
		source: overrides.source ?? `/tmp/${id}/index.ts`,
		origin: overrides.origin ?? "workspace",
		enabled: overrides.enabled ?? true,
		explicitlyEnabled: overrides.explicitlyEnabled ?? overrides.enabled ?? true,
		activated: overrides.activated ?? overrides.enabled ?? true,
		activationSource: overrides.activationSource ?? (overrides.enabled ?? true ? "explicit" : "disabled"),
		activationReason: overrides.activationReason,
		status: overrides.status ?? "loaded",
		toolNames: [],
		hookNames: [],
		channelIds: [],
		cliBackendIds: [],
		providerIds: [],
		embeddingProviderIds: [],
		speechProviderIds: [],
		realtimeTranscriptionProviderIds: [],
		realtimeVoiceProviderIds: [],
		mediaUnderstandingProviderIds: [],
		imageGenerationProviderIds: [],
		videoGenerationProviderIds: [],
		musicGenerationProviderIds: [],
		webFetchProviderIds: [],
		webSearchProviderIds: [],
		migrationProviderIds: [],
		contextEngineIds: [],
		memoryEmbeddingProviderIds: [],
		agentHarnessIds: [],
		cliCommands: [],
		services: [],
		gatewayDiscoveryServiceIds: [],
		commands: [],
		httpRoutes: 0,
		hookCount: 0,
		configSchema: false,
		...rest
	};
}
//#endregion
//#region src/plugins/hooks.test-helpers.ts
function createMockPluginRegistry(hooks) {
	return {
		plugins: (hooks.length > 0 ? [...new Set(hooks.map((hook) => hook.pluginId ?? "test-plugin"))] : ["test-plugin"]).map((pluginId) => createPluginRecord({
			id: pluginId,
			name: "Test Plugin",
			source: "test",
			hookCount: hooks.filter((hook) => (hook.pluginId ?? "test-plugin") === pluginId).length
		})),
		hooks,
		typedHooks: hooks.map((h) => ({
			pluginId: h.pluginId ?? "test-plugin",
			hookName: h.hookName,
			handler: h.handler,
			priority: 0,
			source: "test"
		})),
		tools: [],
		channels: [],
		channelSetups: [],
		providers: [],
		embeddingProviders: [],
		speechProviders: [],
		mediaUnderstandingProviders: [],
		imageGenerationProviders: [],
		videoGenerationProviders: [],
		musicGenerationProviders: [],
		webFetchProviders: [],
		webSearchProviders: [],
		migrationProviders: [],
		codexAppServerExtensionFactories: [],
		agentToolResultMiddlewares: [],
		memoryEmbeddingProviders: [],
		agentHarnesses: [],
		httpRoutes: [],
		gatewayHandlers: {},
		cliRegistrars: [],
		textTransforms: [],
		reloads: [],
		nodeHostCommands: [],
		securityAuditCollectors: [],
		services: [],
		gatewayDiscoveryServices: [],
		conversationBindingResolvedHandlers: [],
		commands: [],
		diagnostics: []
	};
}
function addTestHook(params) {
	params.registry.typedHooks.push({
		pluginId: params.pluginId,
		hookName: params.hookName,
		handler: params.handler,
		priority: params.priority ?? 0,
		...params.timeoutMs !== void 0 ? { timeoutMs: params.timeoutMs } : {},
		source: "test"
	});
}
//#endregion
export { createMockPluginRegistry as n, createPluginRecord as r, addTestHook as t };
