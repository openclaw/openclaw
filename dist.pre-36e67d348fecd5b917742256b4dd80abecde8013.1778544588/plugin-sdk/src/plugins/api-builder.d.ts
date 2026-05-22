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
    handlers?: Partial<Pick<OpenClawPluginApi, "registerTool" | "registerHook" | "registerHttpRoute" | "registerChannel" | "registerGatewayMethod" | "registerCli" | "registerReload" | "registerNodeHostCommand" | "registerNodeInvokePolicy" | "registerSecurityAuditCollector" | "registerService" | "registerGatewayDiscoveryService" | "registerCliBackend" | "registerTextTransforms" | "registerConfigMigration" | "registerMigrationProvider" | "registerAutoEnableProbe" | "registerProvider" | "registerSpeechProvider" | "registerRealtimeTranscriptionProvider" | "registerRealtimeVoiceProvider" | "registerMediaUnderstandingProvider" | "registerImageGenerationProvider" | "registerVideoGenerationProvider" | "registerMusicGenerationProvider" | "registerWebFetchProvider" | "registerWebSearchProvider" | "registerInteractiveHandler" | "onConversationBindingResolved" | "registerCommand" | "registerContextEngine" | "registerCompactionProvider" | "registerAgentHarness" | "registerCodexAppServerExtensionFactory" | "registerAgentToolResultMiddleware" | "registerSessionExtension" | "enqueueNextTurnInjection" | "registerTrustedToolPolicy" | "registerToolMetadata" | "registerControlUiDescriptor" | "registerRuntimeLifecycle" | "registerAgentEventSubscription" | "setRunContext" | "getRunContext" | "clearRunContext" | "registerSessionSchedulerJob" | "registerDetachedTaskRuntime" | "registerMemoryCapability" | "registerMemoryPromptSection" | "registerMemoryPromptSupplement" | "registerMemoryCorpusSupplement" | "registerMemoryFlushPlan" | "registerMemoryRuntime" | "registerMemoryEmbeddingProvider" | "on">>;
};
export declare function buildPluginApi(params: BuildPluginApiParams): OpenClawPluginApi;
