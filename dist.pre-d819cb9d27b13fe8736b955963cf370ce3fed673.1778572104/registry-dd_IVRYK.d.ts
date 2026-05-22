import { i as PluginCompatCode } from "./installed-plugin-index-Hvql9nAS.js";
import { a as PluginDependencyStatus, g as PluginFormat, h as PluginDiagnostic, l as PluginKind, m as PluginConfigUiHint, o as PluginManifestContracts, p as PluginBundleFormat } from "./manifest-registry-5JHEf5jT.js";
import { t as JsonSchemaObject } from "./json-schema.types-Bhym0dYn.js";
import { t as PluginOrigin } from "./plugin-origin.types-CHqRT4Yv.js";
import { r as AnyAgentTool } from "./common-K3KGpeVn.js";
import { N as WebFetchProviderPlugin, S as OpenClawPluginHookOptions, w as OpenClawPluginToolFactory, z as WebSearchProviderPlugin } from "./types-core-C4sdPbS4.js";
import { t as HookEntry } from "./types-Cw6mcJgo.js";
import { A as OpenClawPluginHttpRouteHandler, Bn as SpeechProviderPlugin, C as OpenClawPluginCommandDefinition, D as OpenClawPluginGatewayRuntimeScopeSurface, Er as AgentToolResultMiddlewareRuntime, Hn as UnifiedModelCatalogProviderPlugin, J as OpenClawPluginService, K as OpenClawPluginSecurityAuditCollector, L as OpenClawPluginNodeHostCommand, N as OpenClawPluginHttpRouteUpgradeHandler, O as OpenClawPluginHostedMediaResolver, Oi as MemoryEmbeddingProviderAdapter, Rn as RealtimeTranscriptionProviderPlugin, S as OpenClawPluginCliRegistrar, Un as VideoGenerationProviderPlugin, W as OpenClawPluginReloadRegistration, _t as PluginTextTransformRegistration, b as OpenClawPluginCliCommandDescriptor, br as AgentToolResultMiddleware, d as MigrationProviderPlugin, dr as CliBackendPlugin, h as OpenClawGatewayDiscoveryService, ir as CodexAppServerExtensionFactory, j as OpenClawPluginHttpRouteMatch, k as OpenClawPluginHttpRouteAuth, n as MediaUnderstandingProviderPlugin, ni as AgentHarness, nn as ProviderPlugin, p as MusicGenerationProviderPlugin, pt as PluginRegistrationMode, t as ImageGenerationProviderPlugin, ut as PluginLogger, v as OpenClawPluginApi, y as OpenClawPluginChannelRegistration, z as OpenClawPluginNodeInvokePolicy, zn as RealtimeVoiceProviderPlugin } from "./types-DzNNj7u7.js";
import { $ as PluginHookName, K as PluginHookHandlerMap, et as PluginHookRegistration$1, qt as PluginConversationBindingResolvedEvent } from "./hook-types-14vPwBMK.js";
import { Ao as PluginRuntimeLifecycleRegistration, Do as PluginControlUiDescriptor, Eo as PluginAgentEventSubscriptionRegistration, Go as OperatorScope, Lo as PluginSessionExtensionRegistration, Mo as PluginSessionActionRegistration, Uo as PluginToolMetadataRegistration, Wo as PluginTrustedToolPolicyRegistration, zo as PluginSessionSchedulerJobRegistration } from "./index-7KIB9k5l.js";
import { n as ChannelPlugin } from "./types.public-Bp4rl8_W.js";
import { h as CronServiceContract, i as GatewayRequestHandlers, n as GatewayRequestHandler } from "./types-DUA2OA0o.js";
import { n as PluginRuntime } from "./types-6GKVZ6OQ.js";
import { a as PluginActivationSource } from "./config-state-BwgfR7Mf.js";
import { E as registerInternalHook } from "./internal-hooks-YwosXiCz.js";

//#region src/plugins/registry-types.d.ts
type PluginToolRegistration = {
  pluginId: string;
  pluginName?: string;
  factory: OpenClawPluginToolFactory;
  names: string[];
  declaredNames?: string[];
  optional: boolean;
  source: string;
  rootDir?: string;
};
type PluginCliRegistration = {
  pluginId: string;
  pluginName?: string;
  register: OpenClawPluginCliRegistrar;
  parentPath: string[];
  commands: string[];
  descriptors: OpenClawPluginCliCommandDescriptor[];
  source: string;
  rootDir?: string;
};
type PluginHttpRouteRegistration$1 = {
  pluginId?: string;
  path: string;
  handler: OpenClawPluginHttpRouteHandler;
  handleUpgrade?: OpenClawPluginHttpRouteUpgradeHandler;
  auth: OpenClawPluginHttpRouteAuth;
  match: OpenClawPluginHttpRouteMatch;
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
  nodeCapability?: {
    surface: string;
    ttlMs?: number;
  };
  source?: string;
};
type PluginHostedMediaResolverRegistration = {
  pluginId: string;
  pluginName?: string;
  resolver: OpenClawPluginHostedMediaResolver;
  source: string;
  rootDir?: string;
};
type PluginChannelRegistration = {
  pluginId: string;
  pluginName?: string;
  plugin: ChannelPlugin;
  source: string;
  rootDir?: string;
};
type PluginChannelSetupRegistration = {
  pluginId: string;
  pluginName?: string;
  plugin: ChannelPlugin;
  source: string;
  enabled: boolean;
  rootDir?: string;
};
type PluginProviderRegistration = {
  pluginId: string;
  pluginName?: string;
  provider: ProviderPlugin;
  source: string;
  rootDir?: string;
};
type PluginModelCatalogProviderRegistration = {
  pluginId: string;
  pluginName?: string;
  provider: UnifiedModelCatalogProviderPlugin;
  source: string;
  rootDir?: string;
};
type PluginCliBackendRegistration = {
  pluginId: string;
  pluginName?: string;
  backend: CliBackendPlugin;
  source: string;
  rootDir?: string;
};
type PluginTextTransformsRegistration = {
  pluginId: string;
  pluginName?: string;
  transforms: PluginTextTransformRegistration;
  source: string;
  rootDir?: string;
};
type PluginOwnedProviderRegistration<T extends {
  id: string;
}> = {
  pluginId: string;
  pluginName?: string;
  provider: T;
  source: string;
  rootDir?: string;
};
type PluginSpeechProviderRegistration = PluginOwnedProviderRegistration<SpeechProviderPlugin>;
type PluginRealtimeTranscriptionProviderRegistration = PluginOwnedProviderRegistration<RealtimeTranscriptionProviderPlugin>;
type PluginRealtimeVoiceProviderRegistration = PluginOwnedProviderRegistration<RealtimeVoiceProviderPlugin>;
type PluginMediaUnderstandingProviderRegistration = PluginOwnedProviderRegistration<MediaUnderstandingProviderPlugin>;
type PluginImageGenerationProviderRegistration = PluginOwnedProviderRegistration<ImageGenerationProviderPlugin>;
type PluginVideoGenerationProviderRegistration = PluginOwnedProviderRegistration<VideoGenerationProviderPlugin>;
type PluginMusicGenerationProviderRegistration = PluginOwnedProviderRegistration<MusicGenerationProviderPlugin>;
type PluginWebFetchProviderRegistration = PluginOwnedProviderRegistration<WebFetchProviderPlugin>;
type PluginWebSearchProviderRegistration = PluginOwnedProviderRegistration<WebSearchProviderPlugin>;
type PluginMigrationProviderRegistration = PluginOwnedProviderRegistration<MigrationProviderPlugin>;
type PluginMemoryEmbeddingProviderRegistration = PluginOwnedProviderRegistration<MemoryEmbeddingProviderAdapter>;
type PluginCodexAppServerExtensionFactoryRegistration = {
  pluginId: string;
  pluginName?: string;
  rawFactory: CodexAppServerExtensionFactory;
  factory: CodexAppServerExtensionFactory;
  source: string;
  rootDir?: string;
};
type PluginAgentToolResultMiddlewareRegistration = {
  pluginId: string;
  pluginName?: string;
  rawHandler: AgentToolResultMiddleware;
  handler: AgentToolResultMiddleware;
  runtimes: AgentToolResultMiddlewareRuntime[];
  source: string;
  rootDir?: string;
};
type PluginAgentHarnessRegistration = {
  pluginId: string;
  pluginName?: string;
  harness: AgentHarness;
  source: string;
  rootDir?: string;
};
type PluginHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  rootDir?: string;
};
type PluginServiceRegistration = {
  pluginId: string;
  pluginName?: string;
  service: OpenClawPluginService;
  source: string;
  origin: PluginOrigin;
  trustedOfficialInstall?: boolean;
  rootDir?: string;
};
type PluginGatewayDiscoveryServiceRegistration = {
  pluginId: string;
  pluginName?: string;
  service: OpenClawGatewayDiscoveryService;
  source: string;
  rootDir?: string;
};
type PluginReloadRegistration = {
  pluginId: string;
  pluginName?: string;
  registration: OpenClawPluginReloadRegistration;
  source: string;
  rootDir?: string;
};
type PluginNodeHostCommandRegistration = {
  pluginId: string;
  pluginName?: string;
  command: OpenClawPluginNodeHostCommand;
  source: string;
  rootDir?: string;
};
type PluginNodeInvokePolicyRegistration = {
  pluginId: string;
  pluginName?: string;
  policy: OpenClawPluginNodeInvokePolicy;
  pluginConfig?: Record<string, unknown>;
  source: string;
  rootDir?: string;
};
type PluginSecurityAuditCollectorRegistration = {
  pluginId: string;
  pluginName?: string;
  collector: OpenClawPluginSecurityAuditCollector;
  source: string;
  rootDir?: string;
};
type PluginCommandRegistration = {
  pluginId: string;
  pluginName?: string;
  command: OpenClawPluginCommandDefinition;
  source: string;
  rootDir?: string;
};
type PluginSessionExtensionRegistryRegistration = {
  pluginId: string;
  pluginName?: string;
  extension: PluginSessionExtensionRegistration;
  source: string;
  rootDir?: string;
};
type PluginTrustedToolPolicyRegistryRegistration = {
  pluginId: string;
  pluginName?: string;
  policy: PluginTrustedToolPolicyRegistration;
  source: string;
  rootDir?: string;
};
type PluginToolMetadataRegistryRegistration = {
  pluginId: string;
  pluginName?: string;
  metadata: PluginToolMetadataRegistration;
  source: string;
  rootDir?: string;
};
type PluginControlUiDescriptorRegistryRegistration = {
  pluginId: string;
  pluginName?: string;
  descriptor: PluginControlUiDescriptor;
  source: string;
  rootDir?: string;
};
type PluginRuntimeLifecycleRegistryRegistration = {
  pluginId: string;
  pluginName?: string;
  lifecycle: PluginRuntimeLifecycleRegistration;
  source: string;
  rootDir?: string;
};
type PluginAgentEventSubscriptionRegistryRegistration = {
  pluginId: string;
  pluginName?: string;
  subscription: PluginAgentEventSubscriptionRegistration;
  source: string;
  rootDir?: string;
};
type PluginSessionSchedulerJobRegistryRegistration = {
  pluginId: string;
  pluginName?: string;
  job: PluginSessionSchedulerJobRegistration;
  generation?: number;
  source: string;
  rootDir?: string;
};
type PluginSessionActionRegistryRegistration = {
  pluginId: string;
  pluginName?: string;
  action: PluginSessionActionRegistration;
  source: string;
  rootDir?: string;
};
type PluginConversationBindingResolvedHandlerRegistration = {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
  handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>;
  source: string;
  rootDir?: string;
};
type PluginRecord = {
  id: string;
  name: string;
  version?: string;
  packageName?: string;
  description?: string;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  kind?: PluginKind | PluginKind[];
  source: string;
  rootDir?: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  trustedOfficialInstall?: boolean;
  enabled: boolean;
  explicitlyEnabled?: boolean;
  activated?: boolean;
  imported?: boolean;
  compat?: readonly PluginCompatCode[];
  activationSource?: PluginActivationSource;
  activationReason?: string;
  status: "loaded" | "disabled" | "error";
  error?: string;
  failedAt?: Date;
  failurePhase?: "validation" | "load" | "register";
  toolNames: string[];
  hookNames: string[];
  channelIds: string[];
  cliBackendIds: string[];
  providerIds: string[];
  syntheticAuthRefs?: string[];
  speechProviderIds: string[];
  realtimeTranscriptionProviderIds: string[];
  realtimeVoiceProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  imageGenerationProviderIds: string[];
  videoGenerationProviderIds: string[];
  musicGenerationProviderIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
  migrationProviderIds: string[];
  contextEngineIds?: string[];
  memoryEmbeddingProviderIds: string[];
  agentHarnessIds: string[];
  gatewayMethods: string[];
  cliCommands: string[];
  services: string[];
  gatewayDiscoveryServiceIds: string[];
  commands: string[];
  httpRoutes: number;
  hookCount: number;
  configSchema: boolean;
  configUiHints?: Record<string, PluginConfigUiHint>;
  configJsonSchema?: JsonSchemaObject;
  contracts?: PluginManifestContracts;
  memorySlotSelected?: boolean;
  dependencyStatus?: PluginDependencyStatus;
};
type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
  typedHooks: PluginHookRegistration$1[];
  channels: PluginChannelRegistration[];
  channelSetups: PluginChannelSetupRegistration[];
  providers: PluginProviderRegistration[];
  modelCatalogProviders: PluginModelCatalogProviderRegistration[];
  cliBackends?: PluginCliBackendRegistration[];
  textTransforms: PluginTextTransformsRegistration[];
  speechProviders: PluginSpeechProviderRegistration[];
  realtimeTranscriptionProviders: PluginRealtimeTranscriptionProviderRegistration[];
  realtimeVoiceProviders: PluginRealtimeVoiceProviderRegistration[];
  mediaUnderstandingProviders: PluginMediaUnderstandingProviderRegistration[];
  imageGenerationProviders: PluginImageGenerationProviderRegistration[];
  videoGenerationProviders: PluginVideoGenerationProviderRegistration[];
  musicGenerationProviders: PluginMusicGenerationProviderRegistration[];
  webFetchProviders: PluginWebFetchProviderRegistration[];
  webSearchProviders: PluginWebSearchProviderRegistration[];
  migrationProviders: PluginMigrationProviderRegistration[];
  codexAppServerExtensionFactories: PluginCodexAppServerExtensionFactoryRegistration[];
  agentToolResultMiddlewares: PluginAgentToolResultMiddlewareRegistration[];
  memoryEmbeddingProviders: PluginMemoryEmbeddingProviderRegistration[];
  agentHarnesses: PluginAgentHarnessRegistration[];
  gatewayHandlers: GatewayRequestHandlers;
  coreGatewayMethodNames?: string[];
  gatewayMethodScopes?: Partial<Record<string, OperatorScope>>;
  httpRoutes: PluginHttpRouteRegistration$1[];
  hostedMediaResolvers?: PluginHostedMediaResolverRegistration[];
  cliRegistrars: PluginCliRegistration[];
  reloads?: PluginReloadRegistration[];
  nodeHostCommands?: PluginNodeHostCommandRegistration[];
  nodeInvokePolicies?: PluginNodeInvokePolicyRegistration[];
  securityAuditCollectors?: PluginSecurityAuditCollectorRegistration[];
  services: PluginServiceRegistration[];
  gatewayDiscoveryServices: PluginGatewayDiscoveryServiceRegistration[];
  commands: PluginCommandRegistration[];
  sessionExtensions?: PluginSessionExtensionRegistryRegistration[];
  trustedToolPolicies?: PluginTrustedToolPolicyRegistryRegistration[];
  toolMetadata?: PluginToolMetadataRegistryRegistration[];
  controlUiDescriptors?: PluginControlUiDescriptorRegistryRegistration[];
  runtimeLifecycles?: PluginRuntimeLifecycleRegistryRegistration[];
  agentEventSubscriptions?: PluginAgentEventSubscriptionRegistryRegistration[];
  sessionSchedulerJobs?: PluginSessionSchedulerJobRegistryRegistration[];
  sessionActions?: PluginSessionActionRegistryRegistration[];
  conversationBindingResolvedHandlers: PluginConversationBindingResolvedHandlerRegistration[];
  diagnostics: PluginDiagnostic[];
};
type PluginRegistryParams = {
  logger: PluginLogger;
  coreGatewayHandlers?: GatewayRequestHandlers;
  coreGatewayMethodNames?: readonly string[];
  runtime: PluginRuntime;
  hostServices?: {
    /** May be a live accessor; plugin APIs must read it at call time. */cron?: CronServiceContract;
  };
  activateGlobalSideEffects?: boolean;
};
//#endregion
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
export { PluginRecord as a, PluginTextTransformsRegistration as c, PluginAgentToolResultMiddlewareRegistration as i, createPluginRegistry as n, PluginRegistry as o, createEmptyPluginRegistry as r, PluginRegistryParams as s, PluginHttpRouteRegistration as t };