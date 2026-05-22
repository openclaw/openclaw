import type { AgentHarness } from "../agents/harness/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { type OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import { type PluginAgentEventSubscriptionRegistration, type PluginControlUiDescriptor, type PluginRuntimeLifecycleRegistration, type PluginSessionSchedulerJobRegistration, type PluginSessionExtensionRegistration, type PluginToolMetadataRegistration, type PluginTrustedToolPolicyRegistration } from "./host-hooks.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginHttpRouteRegistration as RegistryTypesPluginHttpRouteRegistration, PluginRecord, PluginRegistry, PluginRegistryParams, PluginTextTransformsRegistration } from "./registry-types.js";
import type { CliBackendPlugin, ImageGenerationProviderPlugin, MusicGenerationProviderPlugin, OpenClawPluginApi, OpenClawPluginChannelRegistration, OpenClawPluginCliCommandDescriptor, OpenClawPluginCliRegistrar, OpenClawPluginCommandDefinition, OpenClawPluginGatewayRuntimeScopeSurface, OpenClawPluginHookOptions, OpenClawPluginNodeHostCommand, OpenClawPluginReloadRegistration, OpenClawPluginSecurityAuditCollector, MediaUnderstandingProviderPlugin, MigrationProviderPlugin, OpenClawPluginService, OpenClawPluginToolFactory, PluginHookHandlerMap, PluginHookName, PluginRegistrationMode, ProviderPlugin, RealtimeTranscriptionProviderPlugin, RealtimeVoiceProviderPlugin, SpeechProviderPlugin, VideoGenerationProviderPlugin, WebSearchProviderPlugin } from "./types.js";
export type PluginHttpRouteRegistration = RegistryTypesPluginHttpRouteRegistration & {
    gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
};
export type { PluginChannelRegistration, PluginChannelSetupRegistration, PluginCliBackendRegistration, PluginCliRegistration, PluginCommandRegistration, PluginConversationBindingResolvedHandlerRegistration, PluginHookRegistration, PluginAgentHarnessRegistration, PluginMemoryEmbeddingProviderRegistration, PluginNodeHostCommandRegistration, PluginProviderRegistration, PluginControlUiDescriptorRegistryRegistration, PluginRuntimeLifecycleRegistryRegistration, PluginRecord, PluginRegistry, PluginRegistryParams, PluginReloadRegistration, PluginSecurityAuditCollectorRegistration, PluginServiceRegistration, PluginSessionExtensionRegistryRegistration, PluginTextTransformsRegistration, PluginToolMetadataRegistryRegistration, PluginTrustedToolPolicyRegistryRegistration, PluginToolRegistration, PluginSpeechProviderRegistration, PluginRealtimeTranscriptionProviderRegistration, PluginRealtimeVoiceProviderRegistration, PluginMediaUnderstandingProviderRegistration, PluginImageGenerationProviderRegistration, PluginVideoGenerationProviderRegistration, PluginMusicGenerationProviderRegistration, PluginWebFetchProviderRegistration, PluginWebSearchProviderRegistration, } from "./registry-types.js";
type PluginTypedHookPolicy = {
    allowPromptInjection?: boolean;
    allowConversationAccess?: boolean;
    timeoutMs?: number;
    timeouts?: Record<string, number>;
};
export { createEmptyPluginRegistry } from "./registry-empty.js";
export declare function resolvePluginPath(input: string, rootDir: string | undefined): string;
export declare function createPluginRegistry(registryParams: PluginRegistryParams): {
    registry: PluginRegistry;
    createApi: (record: PluginRecord, params: {
        config: OpenClawPluginApi["config"];
        pluginConfig?: Record<string, unknown>;
        hookPolicy?: PluginTypedHookPolicy;
        registrationMode?: PluginRegistrationMode;
    }) => OpenClawPluginApi;
    rollbackPluginGlobalSideEffects: (pluginId: string) => void;
    pushDiagnostic: (diag: PluginDiagnostic) => void;
    registerTool: (record: PluginRecord, tool: AnyAgentTool | OpenClawPluginToolFactory, opts?: {
        name?: string;
        names?: string[];
        optional?: boolean;
    }) => void;
    registerChannel: (record: PluginRecord, registration: OpenClawPluginChannelRegistration | ChannelPlugin, mode?: PluginRegistrationMode) => void;
    registerProvider: (record: PluginRecord, provider: ProviderPlugin) => void;
    registerAgentHarness: (record: PluginRecord, harness: AgentHarness) => void;
    registerCliBackend: (record: PluginRecord, backend: CliBackendPlugin) => void;
    registerTextTransforms: (record: PluginRecord, transforms: PluginTextTransformsRegistration["transforms"]) => void;
    registerSpeechProvider: (record: PluginRecord, provider: SpeechProviderPlugin) => void;
    registerRealtimeTranscriptionProvider: (record: PluginRecord, provider: RealtimeTranscriptionProviderPlugin) => void;
    registerRealtimeVoiceProvider: (record: PluginRecord, provider: RealtimeVoiceProviderPlugin) => void;
    registerMediaUnderstandingProvider: (record: PluginRecord, provider: MediaUnderstandingProviderPlugin) => void;
    registerImageGenerationProvider: (record: PluginRecord, provider: ImageGenerationProviderPlugin) => void;
    registerVideoGenerationProvider: (record: PluginRecord, provider: VideoGenerationProviderPlugin) => void;
    registerMusicGenerationProvider: (record: PluginRecord, provider: MusicGenerationProviderPlugin) => void;
    registerWebSearchProvider: (record: PluginRecord, provider: WebSearchProviderPlugin) => void;
    registerMigrationProvider: (record: PluginRecord, provider: MigrationProviderPlugin) => void;
    registerGatewayMethod: (record: PluginRecord, method: string, handler: GatewayRequestHandler, opts?: {
        scope?: OperatorScope;
    }) => void;
    registerCli: (record: PluginRecord, registrar: OpenClawPluginCliRegistrar, opts?: {
        commands?: string[];
        descriptors?: OpenClawPluginCliCommandDescriptor[];
    }) => void;
    registerReload: (record: PluginRecord, registration: OpenClawPluginReloadRegistration) => void;
    registerNodeHostCommand: (record: PluginRecord, nodeCommand: OpenClawPluginNodeHostCommand) => void;
    registerSecurityAuditCollector: (record: PluginRecord, collector: OpenClawPluginSecurityAuditCollector) => void;
    registerService: (record: PluginRecord, service: OpenClawPluginService) => void;
    registerCommand: (record: PluginRecord, command: OpenClawPluginCommandDefinition) => void;
    registerSessionExtension: (record: PluginRecord, extension: PluginSessionExtensionRegistration) => void;
    registerTrustedToolPolicy: (record: PluginRecord, policy: PluginTrustedToolPolicyRegistration) => void;
    registerToolMetadata: (record: PluginRecord, metadata: PluginToolMetadataRegistration) => void;
    registerControlUiDescriptor: (record: PluginRecord, descriptor: PluginControlUiDescriptor) => void;
    registerRuntimeLifecycle: (record: PluginRecord, lifecycle: PluginRuntimeLifecycleRegistration) => void;
    registerAgentEventSubscription: (record: PluginRecord, subscription: PluginAgentEventSubscriptionRegistration) => void;
    registerSessionSchedulerJob: (record: PluginRecord, job: PluginSessionSchedulerJobRegistration) => import("./host-hooks.js").PluginSessionSchedulerJobHandle | undefined;
    registerHook: (record: PluginRecord, events: string | string[], handler: Parameters<typeof registerInternalHook>[1], opts: OpenClawPluginHookOptions | undefined, config: OpenClawPluginApi["config"], pluginConfig: unknown) => void;
    registerTypedHook: <K extends PluginHookName>(record: PluginRecord, hookName: K, handler: PluginHookHandlerMap[K], opts?: {
        priority?: number;
        timeoutMs?: number;
    }, policy?: PluginTypedHookPolicy) => void;
};
