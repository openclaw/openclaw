import type { OpenClawPluginApi } from "../plugin-entry.js";
import { createPluginRegistry, registerProviderPlugins as registerProviders, requireRegisteredProvider as requireProvider, type OpenClawConfig, type PluginRecord } from "../testing.js";
export { assertNoImportTimeSideEffects } from "./import-side-effects.js";
import { uniqueSortedStrings } from "./string-utils.js";
export { registerProviders, requireProvider, uniqueSortedStrings };
export declare function createPluginRegistryFixture(config?: OpenClawConfig): {
    config: OpenClawConfig;
    registry: {
        registry: import("../../plugins/registry-types.ts").PluginRegistry;
        createApi: (record: PluginRecord, params: {
            config: OpenClawPluginApi["config"];
            pluginConfig?: Record<string, unknown>;
            hookPolicy?: {
                allowPromptInjection?: boolean;
                allowConversationAccess?: boolean;
                timeoutMs?: number;
                timeouts?: Record<string, number>;
            };
            registrationMode?: import("../plugin-runtime.ts").PluginRegistrationMode;
        }) => OpenClawPluginApi;
        rollbackPluginGlobalSideEffects: (pluginId: string) => void;
        pushDiagnostic: (diag: import("../plugin-runtime.ts").PluginDiagnostic) => void;
        registerTool: (record: PluginRecord, tool: import("../plugin-entry.js").AnyAgentTool | import("../plugin-entry.js").OpenClawPluginToolFactory, opts?: {
            name?: string;
            names?: string[];
            optional?: boolean;
        }) => void;
        registerChannel: (record: PluginRecord, registration: import("../plugin-runtime.ts").OpenClawPluginChannelRegistration | import("openclaw/plugin-sdk").ChannelPlugin, mode?: import("../plugin-runtime.ts").PluginRegistrationMode) => void;
        registerProvider: (record: PluginRecord, provider: import("./provider-catalog.ts").ProviderPlugin) => void;
        registerAgentHarness: (record: PluginRecord, harness: import("../plugin-entry.js").AgentHarness) => void;
        registerCliBackend: (record: PluginRecord, backend: import("openclaw/plugin-sdk").CliBackendPlugin) => void;
        registerTextTransforms: (record: PluginRecord, transforms: import("../../plugins/registry-types.ts").PluginTextTransformsRegistration["transforms"]) => void;
        registerSpeechProvider: (record: PluginRecord, provider: import("../plugin-entry.js").SpeechProviderPlugin) => void;
        registerRealtimeTranscriptionProvider: (record: PluginRecord, provider: import("../plugin-entry.js").RealtimeTranscriptionProviderPlugin) => void;
        registerRealtimeVoiceProvider: (record: PluginRecord, provider: import("../plugin-runtime.ts").RealtimeVoiceProviderPlugin) => void;
        registerMediaUnderstandingProvider: (record: PluginRecord, provider: import("../plugin-entry.js").MediaUnderstandingProviderPlugin) => void;
        registerImageGenerationProvider: (record: PluginRecord, provider: import("../image-generation-core.ts").ImageGenerationProviderPlugin) => void;
        registerVideoGenerationProvider: (record: PluginRecord, provider: import("../plugin-runtime.ts").VideoGenerationProviderPlugin) => void;
        registerMusicGenerationProvider: (record: PluginRecord, provider: import("../music-generation-core.ts").MusicGenerationProviderPlugin) => void;
        registerWebSearchProvider: (record: PluginRecord, provider: import("../plugin-runtime.ts").WebSearchProviderPlugin) => void;
        registerMigrationProvider: (record: PluginRecord, provider: import("../plugin-entry.js").MigrationProviderPlugin) => void;
        registerGatewayMethod: (record: PluginRecord, method: string, handler: import("../../gateway/server-methods/shared-types.ts").GatewayRequestHandler, opts?: {
            scope?: import("../../gateway/operator-scopes.ts").OperatorScope;
        }) => void;
        registerCli: (record: PluginRecord, registrar: import("../plugin-runtime.ts").OpenClawPluginCliRegistrar, opts?: {
            commands?: string[];
            descriptors?: import("../plugin-runtime.ts").OpenClawPluginCliCommandDescriptor[];
        }) => void;
        registerReload: (record: PluginRecord, registration: import("../plugin-entry.js").OpenClawPluginReloadRegistration) => void;
        registerNodeHostCommand: (record: PluginRecord, nodeCommand: import("../plugin-entry.js").OpenClawPluginNodeHostCommand) => void;
        registerSecurityAuditCollector: (record: PluginRecord, collector: import("../plugin-entry.js").OpenClawPluginSecurityAuditCollector) => void;
        registerService: (record: PluginRecord, service: import("../plugin-entry.js").OpenClawPluginService) => void;
        registerCommand: (record: PluginRecord, command: import("../plugin-entry.js").OpenClawPluginCommandDefinition) => void;
        registerSessionExtension: (record: PluginRecord, extension: import("../plugin-entry.js").PluginSessionExtensionRegistration) => void;
        registerTrustedToolPolicy: (record: PluginRecord, policy: import("../plugin-entry.js").PluginTrustedToolPolicyRegistration) => void;
        registerToolMetadata: (record: PluginRecord, metadata: import("../plugin-entry.js").PluginToolMetadataRegistration) => void;
        registerControlUiDescriptor: (record: PluginRecord, descriptor: import("../plugin-entry.js").PluginControlUiDescriptor) => void;
        registerRuntimeLifecycle: (record: PluginRecord, lifecycle: import("../plugin-entry.js").PluginRuntimeLifecycleRegistration) => void;
        registerAgentEventSubscription: (record: PluginRecord, subscription: import("../plugin-entry.js").PluginAgentEventSubscriptionRegistration) => void;
        registerSessionSchedulerJob: (record: PluginRecord, job: import("../plugin-entry.js").PluginSessionSchedulerJobRegistration) => import("../plugin-entry.js").PluginSessionSchedulerJobHandle | undefined;
        registerHook: (record: PluginRecord, events: string | string[], handler: Parameters<typeof import("../hook-runtime.ts").registerInternalHook>[1], opts: import("../plugin-runtime.ts").OpenClawPluginHookOptions | undefined, config: OpenClawPluginApi["config"], pluginConfig: unknown) => void;
        registerTypedHook: <K extends import("../plugin-runtime.ts").PluginHookName>(record: PluginRecord, hookName: K, handler: import("../plugin-runtime.ts").PluginHookHandlerMap[K], opts?: {
            priority?: number;
            timeoutMs?: number;
        }, policy?: {
            allowPromptInjection?: boolean;
            allowConversationAccess?: boolean;
            timeoutMs?: number;
            timeouts?: Record<string, number>;
        }) => void;
    };
};
export declare function registerTestPlugin(params: {
    registry: ReturnType<typeof createPluginRegistry>;
    config: OpenClawConfig;
    record: PluginRecord;
    register(api: OpenClawPluginApi): void;
}): void;
export declare function registerVirtualTestPlugin(params: {
    registry: ReturnType<typeof createPluginRegistry>;
    config: OpenClawConfig;
    id: string;
    name: string;
    source?: string;
    kind?: PluginRecord["kind"];
    contracts?: PluginRecord["contracts"];
    register(this: void, api: OpenClawPluginApi): void;
}): void;
