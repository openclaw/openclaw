import { r as PluginDiagnostic } from "./manifest-types-BoV01i-B.js";
import { r as AnyAgentTool } from "./common-MKouOaZh.js";
import { S as OpenClawPluginHookOptions, w as OpenClawPluginToolFactory, z as WebSearchProviderPlugin } from "./types-core-DeSCCKji.js";
import { Bn as RealtimeVoiceProviderPlugin, C as OpenClawPluginCliRegistrar, G as OpenClawPluginReloadRegistration, O as OpenClawPluginGatewayRuntimeScopeSurface, R as OpenClawPluginNodeHostCommand, Un as UnifiedModelCatalogProviderPlugin, Vn as SpeechProviderPlugin, Wn as VideoGenerationProviderPlugin, Y as OpenClawPluginService, b as OpenClawPluginChannelRegistration, d as MigrationProviderPlugin, fr as CliBackendPlugin, k as OpenClawPluginHostedMediaResolver, m as MusicGenerationProviderPlugin, mt as PluginRegistrationMode, n as MediaUnderstandingProviderPlugin, q as OpenClawPluginSecurityAuditCollector, ri as AgentHarness, rn as ProviderPlugin, t as ImageGenerationProviderPlugin, w as OpenClawPluginCommandDefinition, x as OpenClawPluginCliCommandDescriptor, y as OpenClawPluginApi, zn as RealtimeTranscriptionProviderPlugin } from "./types-Dd0yIOXW2.js";
import { et as PluginHookName, q as PluginHookHandlerMap } from "./hook-types-Ka3Sctoa.js";
import { Ao as PluginRuntimeLifecycleRegistration, Do as PluginControlUiDescriptor, Eo as PluginAgentEventSubscriptionRegistration, Go as OperatorScope, Lo as PluginSessionExtensionRegistration, Mo as PluginSessionActionRegistration, Uo as PluginToolMetadataRegistration, Wo as PluginTrustedToolPolicyRegistration, zo as PluginSessionSchedulerJobRegistration } from "./index-BRrq4Gm9.js";
import { n as ChannelPlugin } from "./types.public-Dc4Eenvd.js";
import { n as GatewayRequestHandler } from "./types-BP_YLDxx.js";
import { a as PluginRegistryParams, i as PluginRegistry, n as PluginHttpRouteRegistration$1, o as PluginTextTransformsRegistration, r as PluginRecord } from "./registry-types-COstl06H.js";
import { E as registerInternalHook } from "./internal-hooks-B3ngJgIs.js";

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