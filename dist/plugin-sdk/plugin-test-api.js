import { t as attachPluginApiFacades } from "../api-facades-BqeVKWB0.js";
//#region src/plugin-sdk/plugin-test-api.ts
function createTestPluginApi(api = {}) {
	const { agent, lifecycle, runContext, session, ...flatApi } = api;
	return {
		...attachPluginApiFacades({
			id: "test-plugin",
			name: "test-plugin",
			source: "test",
			registrationMode: "full",
			config: {},
			runtime: {},
			logger: {
				info() {},
				warn() {},
				error() {},
				debug() {}
			},
			registerTool() {},
			registerHook() {},
			registerHttpRoute() {},
			registerHostedMediaResolver() {},
			registerChannel() {},
			registerGatewayMethod() {},
			registerCli() {},
			registerNodeCliFeature() {},
			registerCliBackend() {},
			registerTextTransforms() {},
			registerService() {},
			registerGatewayDiscoveryService() {},
			registerReload() {},
			registerNodeHostCommand() {},
			registerNodeInvokePolicy() {},
			registerSecurityAuditCollector() {},
			registerConfigMigration() {},
			registerMigrationProvider() {},
			registerAutoEnableProbe() {},
			registerProvider() {},
			registerModelCatalogProvider() {},
			registerEmbeddingProvider() {},
			registerSpeechProvider() {},
			registerRealtimeTranscriptionProvider() {},
			registerRealtimeVoiceProvider() {},
			registerMediaUnderstandingProvider() {},
			registerImageGenerationProvider() {},
			registerMusicGenerationProvider() {},
			registerVideoGenerationProvider() {},
			registerWebFetchProvider() {},
			registerWebSearchProvider() {},
			registerInteractiveHandler() {},
			onConversationBindingResolved() {},
			registerCommand() {},
			registerContextEngine() {},
			registerCompactionProvider() {},
			registerAgentHarness() {},
			registerCodexAppServerExtensionFactory() {},
			registerAgentToolResultMiddleware() {},
			registerDetachedTaskRuntime() {},
			registerSessionExtension() {},
			enqueueNextTurnInjection: async (injection) => ({
				enqueued: false,
				id: "",
				sessionKey: injection.sessionKey
			}),
			registerTrustedToolPolicy() {},
			registerToolMetadata() {},
			registerControlUiDescriptor() {},
			registerRuntimeLifecycle() {},
			registerAgentEventSubscription() {},
			emitAgentEvent: () => ({
				emitted: false,
				reason: "test api"
			}),
			setRunContext: () => false,
			getRunContext: () => void 0,
			clearRunContext() {},
			registerSessionSchedulerJob: () => void 0,
			registerSessionAction() {},
			sendSessionAttachment: async () => ({
				ok: false,
				error: "test plugin api"
			}),
			scheduleSessionTurn: async () => void 0,
			unscheduleSessionTurnsByTag: async () => ({
				removed: 0,
				failed: 0
			}),
			registerMemoryCapability() {},
			registerMemoryPromptSection() {},
			registerMemoryPromptSupplement() {},
			registerMemoryCorpusSupplement() {},
			registerMemoryFlushPlan() {},
			registerMemoryRuntime() {},
			registerMemoryEmbeddingProvider() {},
			resolvePath(input) {
				return input;
			},
			on() {},
			...flatApi
		}),
		...agent ? { agent } : {},
		...lifecycle ? { lifecycle } : {},
		...runContext ? { runContext } : {},
		...session ? { session } : {}
	};
}
//#endregion
export { createTestPluginApi };
