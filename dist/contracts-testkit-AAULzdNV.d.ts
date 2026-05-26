import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { r as EmbeddingProviderAdapter } from "./embedding-providers-BwXHOC_w.js";
import { r as PluginDiagnostic } from "./manifest-types-C_IWdo1j.js";
import { E as OpenClawPluginHookOptions, O as OpenClawPluginToolFactory, U as WebSearchProviderPlugin } from "./types-core-DxqEkbXr.js";
import { r as AnyAgentTool } from "./common-BDN0bXby.js";
import { $ as OpenClawPluginService, C as OpenClawPluginApi, D as OpenClawPluginCliRegistrar, Gn as SpeechProviderPlugin, H as OpenClawPluginNodeHostCommand, Jn as VideoGenerationProviderPlugin, N as OpenClawPluginHostedMediaResolver, O as OpenClawPluginCommandDefinition, T as OpenClawPluginCliCommandDescriptor, Un as RealtimeTranscriptionProviderPlugin, Wn as RealtimeVoiceProviderPlugin, Y as OpenClawPluginReloadRegistration, Z as OpenClawPluginSecurityAuditCollector, a as ImageGenerationProviderPlugin, gr as CliBackendPlugin, h as MigrationProviderPlugin, o as MediaUnderstandingProviderPlugin, qn as UnifiedModelCatalogProviderPlugin, si as AgentHarness, sn as ProviderPlugin, v as MusicGenerationProviderPlugin, vt as PluginRegistrationMode, w as OpenClawPluginChannelRegistration } from "./types-Vx7Jq4_-2.js";
import { et as PluginHookName, q as PluginHookHandlerMap } from "./hook-types-BKz-S4lu.js";
import { Ao as PluginRuntimeLifecycleRegistration, Do as PluginControlUiDescriptor, Eo as PluginAgentEventSubscriptionRegistration, Go as OperatorScope, Lo as PluginSessionExtensionRegistration, Mo as PluginSessionActionRegistration, Uo as PluginToolMetadataRegistration, Wo as PluginTrustedToolPolicyRegistration, zo as PluginSessionSchedulerJobRegistration } from "./index-CaLNQFzV.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
import { n as GatewayRequestHandler } from "./types-BMFYBAxt.js";
import { a as PluginRegistryParams, i as PluginRegistry, o as PluginTextTransformsRegistration, r as PluginRecord } from "./registry-types-F3hmOVKr.js";
import { E as registerInternalHook } from "./internal-hooks-DlJCPrD5.js";
import { n as createPluginRegistry } from "./registry-Dpy69Csr.js";
import { t as provider_catalog_runtime_d_exports } from "./provider-catalog-runtime-BsBOhRMc.js";

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
declare function createPluginRegistryFixture(config?: OpenClawConfig, params?: {
  hostServices?: PluginRegistryParams["hostServices"];
}): {
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