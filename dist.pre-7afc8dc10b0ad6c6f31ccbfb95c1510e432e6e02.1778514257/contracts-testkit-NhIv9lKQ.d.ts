import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { h as PluginDiagnostic } from "./manifest-registry-DAlzfkU_.js";
import { r as AnyAgentTool } from "./common-BTwhyOZ1.js";
import { S as OpenClawPluginHookOptions, w as OpenClawPluginToolFactory, z as WebSearchProviderPlugin } from "./types-core-aEWdlOh5.js";
import { An as RealtimeTranscriptionProviderPlugin, E as OpenClawPluginHostedMediaResolver, Fn as VideoGenerationProviderPlugin, H as OpenClawPluginSecurityAuditCollector, Jr as AgentHarness, Jt as ProviderPlugin, Mn as SpeechProviderPlugin, P as OpenClawPluginNodeHostCommand, Pn as UnifiedModelCatalogProviderPlugin, V as OpenClawPluginReloadRegistration, W as OpenClawPluginService, _ as OpenClawPluginChannelRegistration, at as PluginRegistrationMode, b as OpenClawPluginCliRegistrar, d as MigrationProviderPlugin, g as OpenClawPluginApi, jn as RealtimeVoiceProviderPlugin, n as MediaUnderstandingProviderPlugin, p as MusicGenerationProviderPlugin, rr as CliBackendPlugin, t as ImageGenerationProviderPlugin, v as OpenClawPluginCliCommandDescriptor, x as OpenClawPluginCommandDefinition } from "./types-BOTb5nyG.js";
import { $ as PluginHookName, K as PluginHookHandlerMap } from "./hook-types-uik7367C.js";
import { Do as PluginToolMetadataRegistration, Eo as PluginSessionSchedulerJobRegistration, Oo as PluginTrustedToolPolicyRegistration, So as PluginRuntimeLifecycleRegistration, ko as OperatorScope, vo as PluginAgentEventSubscriptionRegistration, wo as PluginSessionExtensionRegistration, yo as PluginControlUiDescriptor } from "./index-FyLSqSFO.js";
import { n as ChannelPlugin } from "./types.public-D_xOTs5v.js";
import { n as GatewayRequestHandler } from "./types-DZSMYXQj.js";
import { a as PluginRecord, n as createPluginRegistry, o as PluginRegistry, s as PluginTextTransformsRegistration } from "./registry-D5v5qxGZ.js";
import { E as registerInternalHook } from "./internal-hooks-CjcPHjUQ.js";
import { t as provider_catalog_runtime_d_exports } from "./provider-catalog-runtime-BQ_Ukwvq.js";

//#region src/plugin-sdk/test-helpers/public-surface-loader.d.ts
type AsyncBundledPluginPublicSurfaceLoader = <T extends object>(params: {
  pluginId: string;
  artifactBasename: string;
}) => Promise<T>;
type BundledPluginPublicSurfaceLoader = <T extends object>(params: {
  pluginId: string;
  artifactBasename: string;
}) => T;
declare const loadBundledPluginPublicSurface: AsyncBundledPluginPublicSurfaceLoader;
declare const loadBundledPluginPublicSurfaceSync: BundledPluginPublicSurfaceLoader;
declare function resolveWorkspacePackagePublicModuleUrl(params: {
  packageName: string;
  artifactBasename: string;
}): string;
//#endregion
//#region src/plugin-sdk/test-helpers/provider-catalog.d.ts
type ProviderRuntimeCatalogModule = Pick<typeof provider_catalog_runtime_d_exports, "augmentModelCatalogWithProviderPlugins">;
declare function importProviderRuntimeCatalogModule(): Promise<ProviderRuntimeCatalogModule>;
//#endregion
//#region src/plugin-sdk/test-helpers/import-side-effects.d.ts
declare function assertNoImportTimeSideEffects(params: {
  moduleId: string;
  forbiddenSeam: string;
  calls: readonly (readonly unknown[])[];
  why: string;
  fixHint: string;
}): void;
//#endregion
//#region src/plugin-sdk/test-helpers/string-utils.d.ts
declare function uniqueSortedStrings(values: readonly string[]): string[];
//#endregion
//#region src/plugin-sdk/test-helpers/contracts-testkit.d.ts
declare function createPluginRegistryFixture(config?: OpenClawConfig): {
  config: OpenClawConfig;
  registry: {
    registry: PluginRegistry;
    createApi: (record: PluginRecord, params: {
      config: OpenClawPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
      hookPolicy?: {
        allowPromptInjection?: boolean;
        allowConversationAccess?: boolean;
        timeoutMs?: number;
        timeouts?: Record<string, number>;
      };
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
    registerHook: (record: PluginRecord, events: string | string[], handler: Parameters<typeof registerInternalHook>[1], opts: OpenClawPluginHookOptions | undefined, config: OpenClawPluginApi["config"], pluginConfig: unknown) => void;
    registerTypedHook: <K extends PluginHookName>(record: PluginRecord, hookName: K, handler: PluginHookHandlerMap[K], opts?: {
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
declare function registerTestPlugin(params: {
  registry: ReturnType<typeof createPluginRegistry>;
  config: OpenClawConfig;
  record: PluginRecord;
  register(api: OpenClawPluginApi): void;
}): void;
declare function registerVirtualTestPlugin(params: {
  registry: ReturnType<typeof createPluginRegistry>;
  config: OpenClawConfig;
  id: string;
  name: string;
  source?: string;
  kind?: PluginRecord["kind"];
  contracts?: PluginRecord["contracts"];
  register(this: void, api: OpenClawPluginApi): void;
}): void;
//#endregion
export { assertNoImportTimeSideEffects as a, loadBundledPluginPublicSurfaceSync as c, uniqueSortedStrings as i, resolveWorkspacePackagePublicModuleUrl as l, registerTestPlugin as n, importProviderRuntimeCatalogModule as o, registerVirtualTestPlugin as r, loadBundledPluginPublicSurface as s, createPluginRegistryFixture as t };