import { r as EmbeddingProviderAdapter } from "./embedding-providers-BwXHOC_w.js";
import { r as PluginDiagnostic } from "./manifest-types-C_IWdo1j.js";
import { E as OpenClawPluginHookOptions, O as OpenClawPluginToolFactory, U as WebSearchProviderPlugin } from "./types-core-DxqEkbXr.js";
import { r as AnyAgentTool } from "./common-BDN0bXby.js";
import { $ as OpenClawPluginService, C as OpenClawPluginApi, D as OpenClawPluginCliRegistrar, Gn as SpeechProviderPlugin, H as OpenClawPluginNodeHostCommand, Jn as VideoGenerationProviderPlugin, M as OpenClawPluginGatewayRuntimeScopeSurface, N as OpenClawPluginHostedMediaResolver, O as OpenClawPluginCommandDefinition, T as OpenClawPluginCliCommandDescriptor, Un as RealtimeTranscriptionProviderPlugin, Wn as RealtimeVoiceProviderPlugin, Y as OpenClawPluginReloadRegistration, Z as OpenClawPluginSecurityAuditCollector, a as ImageGenerationProviderPlugin, gr as CliBackendPlugin, h as MigrationProviderPlugin, o as MediaUnderstandingProviderPlugin, qn as UnifiedModelCatalogProviderPlugin, si as AgentHarness, sn as ProviderPlugin, v as MusicGenerationProviderPlugin, vt as PluginRegistrationMode, w as OpenClawPluginChannelRegistration } from "./types-Vx7Jq4_-2.js";
import { et as PluginHookName, q as PluginHookHandlerMap } from "./hook-types-BKz-S4lu.js";
import { Ao as PluginRuntimeLifecycleRegistration, Do as PluginControlUiDescriptor, Eo as PluginAgentEventSubscriptionRegistration, Go as OperatorScope, Lo as PluginSessionExtensionRegistration, Mo as PluginSessionActionRegistration, Uo as PluginToolMetadataRegistration, Wo as PluginTrustedToolPolicyRegistration, zo as PluginSessionSchedulerJobRegistration } from "./index-CaLNQFzV.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
import { n as GatewayRequestHandler } from "./types-BMFYBAxt.js";
import { a as PluginRegistryParams, i as PluginRegistry, n as PluginHttpRouteRegistration$1, o as PluginTextTransformsRegistration, r as PluginRecord } from "./registry-types-F3hmOVKr.js";
import { E as registerInternalHook } from "./internal-hooks-DlJCPrD5.js";

//#region src/plugins/registry-empty.d.ts
declare function createEmptyPluginRegistry(): PluginRegistry;
//#endregion
//#region src/plugins/registry.d.ts
type PluginHttpRouteRegistration = PluginHttpRouteRegistration$1 & {
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
};
type PluginTypedHookPolicy = {
  allowPromptInjection?: boolean;
  allowConversationAccess?: boolean;
  timeoutMs?: number;
  timeouts?: Record<string, number>;
};
declare function createPluginRegistry(registryParams: PluginRegistryParams): {
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
  registerHostedMediaResolver: (record: PluginRecord, resolver: OpenClawPluginHostedMediaResolver) => void;
  registerProvider: (record: PluginRecord, provider: ProviderPlugin) => void;
  registerModelCatalogProvider: (record: PluginRecord, provider: UnifiedModelCatalogProviderPlugin) => void;
  registerAgentHarness: (record: PluginRecord, harness: AgentHarness) => void;
  registerCliBackend: (record: PluginRecord, backend: CliBackendPlugin) => void;
  registerTextTransforms: (record: PluginRecord, transforms: PluginTextTransformsRegistration["transforms"]) => void;
  registerEmbeddingProvider: (record: PluginRecord, adapter: EmbeddingProviderAdapter) => void;
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
    parentPath?: string[];
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
  registerSessionSchedulerJob: (record: PluginRecord, job: PluginSessionSchedulerJobRegistration) => {
    id: string;
    pluginId: string;
    sessionKey: string;
    kind: string;
  } | undefined;
  registerSessionAction: (record: PluginRecord, action: PluginSessionActionRegistration) => void;
  registerHook: (record: PluginRecord, events: string | string[], handler: Parameters<typeof registerInternalHook>[1], opts: OpenClawPluginHookOptions | undefined, config: OpenClawPluginApi["config"], pluginConfig: unknown) => void;
  registerTypedHook: <K extends PluginHookName>(record: PluginRecord, hookName: K, handler: PluginHookHandlerMap[K], opts?: {
    priority?: number;
    timeoutMs?: number;
  }, policy?: PluginTypedHookPolicy) => void;
};
//#endregion
export { createPluginRegistry as n, createEmptyPluginRegistry as r, PluginHttpRouteRegistration as t };