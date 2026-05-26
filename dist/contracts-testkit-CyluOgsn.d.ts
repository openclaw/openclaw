import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { r as PluginDiagnostic } from "./manifest-types-DjmV4Gol.js";
import { S as OpenClawPluginHookOptions, w as OpenClawPluginToolFactory, z as WebSearchProviderPlugin } from "./types-core-CxmUEffr.js";
import { r as AnyAgentTool } from "./common-5s-NiX7e.js";
import { Bn as SpeechProviderPlugin, C as OpenClawPluginCommandDefinition, Hn as UnifiedModelCatalogProviderPlugin, J as OpenClawPluginService, K as OpenClawPluginSecurityAuditCollector, L as OpenClawPluginNodeHostCommand, O as OpenClawPluginHostedMediaResolver, Rn as RealtimeTranscriptionProviderPlugin, S as OpenClawPluginCliRegistrar, Un as VideoGenerationProviderPlugin, W as OpenClawPluginReloadRegistration, b as OpenClawPluginCliCommandDescriptor, d as MigrationProviderPlugin, dr as CliBackendPlugin, n as MediaUnderstandingProviderPlugin, ni as AgentHarness, nn as ProviderPlugin, p as MusicGenerationProviderPlugin, pt as PluginRegistrationMode, t as ImageGenerationProviderPlugin, v as OpenClawPluginApi, y as OpenClawPluginChannelRegistration, zn as RealtimeVoiceProviderPlugin } from "./types-lCXG2pW_.js";
import { $ as PluginHookName, K as PluginHookHandlerMap } from "./hook-types-CECscVcN.js";
import { Ao as PluginRuntimeLifecycleRegistration, Do as PluginControlUiDescriptor, Eo as PluginAgentEventSubscriptionRegistration, Go as OperatorScope, Lo as PluginSessionExtensionRegistration, Mo as PluginSessionActionRegistration, Uo as PluginToolMetadataRegistration, Wo as PluginTrustedToolPolicyRegistration, zo as PluginSessionSchedulerJobRegistration } from "./index-BtU77z_H.js";
import { n as ChannelPlugin } from "./types.public-BfuQlAVf.js";
import { n as GatewayRequestHandler } from "./types-BczMykKN.js";
import { a as PluginRegistryParams, i as PluginRegistry, o as PluginTextTransformsRegistration, r as PluginRecord } from "./registry-types-D8znGoeh.js";
import { E as registerInternalHook } from "./internal-hooks-DrhDdnAX.js";
import { n as createPluginRegistry } from "./registry-DD9O67NC.js";
import { t as provider_catalog_runtime_d_exports } from "./provider-catalog-runtime-CtHKM58D.js";

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