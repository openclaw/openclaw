import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi, PluginLogger } from "./types.js";
export type BuildPluginApiParams = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    rootDir?: string;
    registrationMode: OpenClawPluginApi["registrationMode"];
    config: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
    runtime: PluginRuntime;
    logger: PluginLogger;
    resolvePath: (input: string) => string;
    handlers?: Partial<Pick<OpenClawPluginApi, "registerTool" | "registerHook" | "registerHttpRoute" | "registerHostedMediaResolver" | "registerChannel" | "registerGatewayMethod" | "registerCli" | "registerReload" | "registerNodeHostCommand" | "registerNodeInvokePolicy" | "registerSecurityAuditCollector" | "registerService" | "registerGatewayDiscoveryService" | "registerCliBackend" | "registerTextTransforms" | "registerConfigMigration" | "registerMigrationProvider" | "registerAutoEnableProbe" | "registerProvider" | "registerModelCatalogProvider" | "registerEmbeddingProvider" | "registerSpeechProvider" | "registerRealtimeTranscriptionProvider" | "registerRealtimeVoiceProvider" | "registerMediaUnderstandingProvider" | "registerImageGenerationProvider" | "registerVideoGenerationProvider" | "registerMusicGenerationProvider" | "registerWebFetchProvider" | "registerWebSearchProvider" | "registerInteractiveHandler" | "onConversationBindingResolved" | "registerCommand" | "registerContextEngine" | "registerCompactionProvider" | "registerAgentHarness" | "registerCodexAppServerExtensionFactory" | "registerAgentToolResultMiddleware" | "registerSessionExtension" | "enqueueNextTurnInjection" | "registerTrustedToolPolicy" | "registerToolMetadata" | "registerControlUiDescriptor" | "registerRuntimeLifecycle" | "registerAgentEventSubscription" | "emitAgentEvent" | "setRunContext" | "getRunContext" | "clearRunContext" | "registerSessionSchedulerJob" | "registerSessionAction" | "sendSessionAttachment" | "scheduleSessionTurn" | "unscheduleSessionTurnsByTag" | "registerDetachedTaskRuntime" | "registerMemoryCapability" | "registerMemoryPromptSection" | "registerMemoryPromptSupplement" | "registerMemoryCorpusSupplement" | "registerMemoryFlushPlan" | "registerMemoryRuntime" | "registerMemoryEmbeddingProvider" | "on">>;
};
export declare function buildPluginApi(params: BuildPluginApiParams): OpenClawPluginApi;
