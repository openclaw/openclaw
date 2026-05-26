import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { r as EmbeddingProviderAdapter } from "./embedding-providers-BwXHOC_w.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { L as WebFetchProviderPlugin, M as PluginWebFetchProviderEntry, N as PluginWebSearchProviderEntry, U as WebSearchProviderPlugin, w as PluginRuntimeTaskFlow } from "./types-core-DxqEkbXr.js";
import { n as RuntimeEnv, t as OutputRuntimeEnv } from "./runtime-Bxifh4bY.js";
import { i as WizardPrompter } from "./prompts-DgKIGa-v.js";
import { r as AnyAgentTool } from "./common-BDN0bXby.js";
import { n as ChannelOutboundAdapter } from "./outbound.types-D7agCOHK.js";
import { K as ChannelMessageActionName$1, T as ChannelMessagingAdapter, c as ChannelCapabilities } from "./types.core-BkmTlRzr.js";
import { C as OpenClawPluginApi, D as OpenClawPluginCliRegistrar, Dt as ProviderAuthMethod, Gn as SpeechProviderPlugin, Jn as VideoGenerationProviderPlugin, St as PluginTextTransformRegistration, T as OpenClawPluginCliCommandDescriptor, Un as RealtimeTranscriptionProviderPlugin, Wn as RealtimeVoiceProviderPlugin, a as ImageGenerationProviderPlugin, fn as ProviderPluginWizardSetup, gr as CliBackendPlugin, h as MigrationProviderPlugin, ht as PluginLogger, lr as CodexAppServerExtensionFactory, o as MediaUnderstandingProviderPlugin, qn as UnifiedModelCatalogProviderPlugin, si as AgentHarness, sn as ProviderPlugin, v as MusicGenerationProviderPlugin, zi as MemoryEmbeddingProviderAdapter, zt as ProviderCatalogResult } from "./types-Vx7Jq4_-2.js";
import { tt as PluginHookRegistration } from "./hook-types-BKz-S4lu.js";
import { a as ChannelSetupStatus, c as ChannelSetupWizardAdapter, i as ChannelSetupResult, o as ChannelSetupStatusContext, t as ChannelSetupConfigureContext } from "./setup-wizard-types-BKBpG8mO.js";
import { Ao as PluginRuntimeLifecycleRegistration, Do as PluginControlUiDescriptor, Eo as PluginAgentEventSubscriptionRegistration, Lo as PluginSessionExtensionRegistration, Mo as PluginSessionActionRegistration, Uo as PluginToolMetadataRegistration, Wo as PluginTrustedToolPolicyRegistration, zo as PluginSessionSchedulerJobRegistration } from "./index-CaLNQFzV.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
import { n as PluginRuntime } from "./types-DpjQFFwi.js";
import { i as PluginRegistry, r as PluginRecord, t as PluginAgentToolResultMiddlewareRegistration } from "./registry-types-F3hmOVKr.js";
import { u as buildChannelSetupWizardAdapterFromSetupWizard } from "./setup-wizard-binary-ByKFs1QA.js";
import { Mock } from "vitest";

//#region src/channels/plugins/types.d.ts
type ChannelMessageActionName = ChannelMessageActionName$1;
//#endregion
//#region src/commands/channel-test-registry.d.ts
declare function setDefaultChannelPluginRegistryForTests(): void;
//#endregion
//#region src/plugins/contracts/inventory/bundled-capability-metadata.d.ts
type BundledPluginContractSnapshot = {
  pluginId: string;
  cliBackendIds: string[];
  providerIds: string[];
  providerAuthEnvVars: Record<string, string[]>;
  embeddingProviderIds: string[];
  speechProviderIds: string[];
  realtimeTranscriptionProviderIds: string[];
  realtimeVoiceProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  documentExtractorIds: string[];
  imageGenerationProviderIds: string[];
  videoGenerationProviderIds: string[];
  musicGenerationProviderIds: string[];
  webContentExtractorIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
  migrationProviderIds: string[];
  toolNames: string[];
};
//#endregion
//#region src/plugins/contracts/registry.d.ts
type CapabilityContractEntry<T> = {
  pluginId: string;
  provider: T;
};
type WebSearchProviderContractEntry = CapabilityContractEntry<WebSearchProviderPlugin> & {
  credentialValue: unknown;
};
type WebFetchProviderContractEntry = CapabilityContractEntry<WebFetchProviderPlugin> & {
  credentialValue: unknown;
};
type PluginRegistrationContractEntry = BundledPluginContractSnapshot;
declare let providerContractLoadError: Error | undefined;
declare function resolveWebFetchProviderContractEntriesForPluginId(pluginId: string): WebFetchProviderContractEntry[];
declare function resolveWebSearchProviderContractEntriesForPluginId(pluginId: string): WebSearchProviderContractEntry[];
declare function resolveProviderContractProvidersForPluginIds(pluginIds: readonly string[]): ProviderPlugin[];
declare const pluginRegistrationContractRegistry: PluginRegistrationContractEntry[];
//#endregion
//#region src/plugins/provider-contract-public-artifacts.d.ts
type ProviderContractEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};
declare function resolveBundledExplicitProviderContractsFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): ProviderContractEntry[] | null;
//#endregion
//#region src/plugins/hooks.test-helpers.d.ts
declare function createMockPluginRegistry(hooks: Array<{
  hookName: string;
  handler: (...args: unknown[]) => unknown;
  pluginId?: string;
}>): PluginRegistry;
declare function addTestHook(params: {
  registry: PluginRegistry;
  pluginId: string;
  hookName: PluginHookRegistration["hookName"];
  handler: PluginHookRegistration["handler"];
  priority?: number;
  timeoutMs?: number;
}): void;
//#endregion
//#region src/plugins/status.test-helpers.d.ts
declare function createPluginRecord(overrides: Partial<PluginRecord> & Pick<PluginRecord, "id">): PluginRecord;
//#endregion
//#region src/plugins/web-provider-public-artifacts.explicit.d.ts
declare function resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebSearchProviderEntry[] | null;
declare function resolveBundledExplicitWebFetchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebFetchProviderEntry[] | null;
//#endregion
//#region src/plugins/runtime.d.ts
declare function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string, runtimeSubagentMode?: "default" | "explicit" | "gateway-bindable", workspaceDir?: string): void;
declare function getActivePluginRegistry(): PluginRegistry | null;
declare function releasePinnedPluginChannelRegistry(registry?: PluginRegistry): void;
declare function resetPluginRuntimeStateForTest(): void;
//#endregion
//#region src/plugin-sdk/facade-loader.d.ts
declare function listImportedBundledPluginFacadeIds(): string[];
//#endregion
//#region src/plugin-sdk/facade-runtime.d.ts
declare function resetFacadeRuntimeStateForTest(): void;
//#endregion
//#region src/plugins/captured-registration.d.ts
type CapturedPluginCliRegistration = {
  register: OpenClawPluginCliRegistrar;
  parentPath: string[];
  commands: string[];
  descriptors: OpenClawPluginCliCommandDescriptor[];
};
type CapturedPluginRegistration = {
  api: OpenClawPluginApi;
  providers: ProviderPlugin[];
  agentHarnesses: AgentHarness[];
  cliRegistrars: CapturedPluginCliRegistration[];
  cliBackends: CliBackendPlugin[];
  textTransforms: PluginTextTransformRegistration[];
  codexAppServerExtensionFactories: CodexAppServerExtensionFactory[];
  agentToolResultMiddlewares: PluginAgentToolResultMiddlewareRegistration[];
  embeddingProviders: EmbeddingProviderAdapter[];
  speechProviders: SpeechProviderPlugin[];
  realtimeTranscriptionProviders: RealtimeTranscriptionProviderPlugin[];
  realtimeVoiceProviders: RealtimeVoiceProviderPlugin[];
  mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[];
  imageGenerationProviders: ImageGenerationProviderPlugin[];
  videoGenerationProviders: VideoGenerationProviderPlugin[];
  musicGenerationProviders: MusicGenerationProviderPlugin[];
  webFetchProviders: WebFetchProviderPlugin[];
  webSearchProviders: WebSearchProviderPlugin[];
  migrationProviders: MigrationProviderPlugin[];
  memoryEmbeddingProviders: MemoryEmbeddingProviderAdapter[];
  sessionExtensions: PluginSessionExtensionRegistration[];
  trustedToolPolicies: PluginTrustedToolPolicyRegistration[];
  toolMetadata: PluginToolMetadataRegistration[];
  controlUiDescriptors: PluginControlUiDescriptor[];
  runtimeLifecycles: PluginRuntimeLifecycleRegistration[];
  agentEventSubscriptions: PluginAgentEventSubscriptionRegistration[];
  sessionSchedulerJobs: PluginSessionSchedulerJobRegistration[];
  sessionActions: PluginSessionActionRegistration[];
  tools: AnyAgentTool[];
  modelCatalogProviders: UnifiedModelCatalogProviderPlugin[];
};
declare function createCapturedPluginRegistration(params?: {
  config?: OpenClawConfig;
  id?: string;
  name?: string;
  registrationMode?: OpenClawPluginApi["registrationMode"];
  source?: string;
}): CapturedPluginRegistration;
declare function capturePluginRegistration(params: NonNullable<Parameters<typeof createCapturedPluginRegistration>[0]> & {
  register(api: OpenClawPluginApi): void;
}): CapturedPluginRegistration;
//#endregion
//#region src/plugins/provider-discovery.d.ts
declare function runProviderCatalog(params: {
  provider: ProviderPlugin;
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: (providerId?: string) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
  };
  resolveProviderAuth: (providerId?: string, options?: {
    oauthMarker?: string;
  }) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "aws-sdk" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
    profileId?: string;
  };
}): Promise<ProviderCatalogResult> | undefined;
//#endregion
//#region src/plugins/provider-wizard.d.ts
type ProviderWizardOption = {
  value: string;
  label: string;
  hint?: string;
  groupId: string;
  groupLabel: string;
  groupHint?: string;
  onboardingScopes?: Array<"text-inference" | "image-generation" | "music-generation">;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  onboardingFeatured?: boolean;
};
type ProviderModelPickerEntry = {
  value: string;
  label: string;
  hint?: string;
};
type ProviderWizardProvidersResolver = (params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) => ProviderPlugin[];
declare function setProviderWizardProvidersResolverForTest(resolver: ProviderWizardProvidersResolver | undefined): () => void;
declare function buildProviderPluginMethodChoice(providerId: string, methodId: string): string;
declare function resolveProviderWizardOptions(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderWizardOption[];
declare function resolveProviderModelPickerEntries(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerEntry[];
declare function resolveProviderPluginChoice$1(params: {
  providers: ProviderPlugin[];
  choice: string;
}): {
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
  wizard?: ProviderPluginWizardSetup;
} | null;
//#endregion
//#region src/plugins/provider-auth-choice.runtime.d.ts
type ResolveProviderPluginChoice = typeof resolveProviderPluginChoice$1;
declare function resolveProviderPluginChoice(...args: Parameters<ResolveProviderPluginChoice>): ReturnType<ResolveProviderPluginChoice>;
//#endregion
//#region src/test-utils/channel-plugins.d.ts
type TestChannelRegistration = {
  pluginId: string;
  plugin: unknown;
  source: string;
};
declare const createTestRegistry: (channels?: TestChannelRegistration[]) => PluginRegistry;
declare const createOutboundTestPlugin: (params: {
  id: ChannelId;
  outbound: ChannelOutboundAdapter;
  messaging?: ChannelMessagingAdapter;
  label?: string;
  docsPath?: string;
  capabilities?: ChannelCapabilities;
}) => ChannelPlugin;
//#endregion
//#region src/test-utils/plugin-registration.d.ts
type RegistrablePlugin = {
  register(api: OpenClawPluginApi): void;
};
type RegisteredProviderCollections = {
  providers: ProviderPlugin[];
  realtimeTranscriptionProviders: RealtimeTranscriptionProviderPlugin[];
  speechProviders: SpeechProviderPlugin[];
  mediaProviders: MediaUnderstandingProviderPlugin[];
  imageProviders: ImageGenerationProviderPlugin[];
  musicProviders: MusicGenerationProviderPlugin[];
  videoProviders: VideoGenerationProviderPlugin[];
  modelCatalogProviders: UnifiedModelCatalogProviderPlugin[];
};
declare function registerSingleProviderPlugin(params: {
  register(api: OpenClawPluginApi): void;
}): Promise<ProviderPlugin>;
declare function registerProviderPlugin(params: {
  plugin: RegistrablePlugin;
  id: string;
  name: string;
}): Promise<RegisteredProviderCollections>;
declare function registerProviderPlugins(...plugins: RegistrablePlugin[]): Promise<ProviderPlugin[]>;
declare function requireRegisteredProvider<T extends {
  id: string;
}>(providers: T[], providerId: string, label?: string): T;
//#endregion
//#region src/test-utils/plugin-runtime-env.d.ts
type RuntimeEnvOptions = {
  throwOnExit?: boolean;
};
declare function createRuntimeEnv(options?: RuntimeEnvOptions): OutputRuntimeEnv;
declare function createTypedRuntimeEnv<TRuntime extends RuntimeEnv = OutputRuntimeEnv>(options?: RuntimeEnvOptions, _runtimeShape?: (runtime: TRuntime) => void): TRuntime;
declare function createNonExitingRuntimeEnv(): OutputRuntimeEnv;
declare function createNonExitingTypedRuntimeEnv<TRuntime extends RuntimeEnv = OutputRuntimeEnv>(runtimeShape?: (runtime: TRuntime) => void): TRuntime;
//#endregion
//#region src/test-utils/plugin-setup-wizard.d.ts
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type QueuedWizardPrompter = {
  intro: AsyncUnknownMock;
  outro: AsyncUnknownMock;
  note: AsyncUnknownMock;
  plain: AsyncUnknownMock;
  select: AsyncUnknownMock;
  multiselect: AsyncUnknownMock;
  text: AsyncUnknownMock;
  confirm: AsyncUnknownMock;
  progress: Mock<() => {
    update: UnknownMock;
    stop: UnknownMock;
  }>;
  prompter: WizardPrompter;
};
declare function selectFirstWizardOption<T>(params: {
  options: Array<{
    value: T;
  }>;
}): Promise<T>;
declare function createTestWizardPrompter(overrides?: Partial<WizardPrompter>): WizardPrompter;
declare function createQueuedWizardPrompter(params?: {
  selectValues?: string[];
  textValues?: string[];
  confirmValues?: boolean[];
}): QueuedWizardPrompter;
type SetupWizardAdapterParams = Parameters<typeof buildChannelSetupWizardAdapterFromSetupWizard>[0];
type SetupWizardCredentialValues = Record<string, string>;
type SetupWizardTestPlugin = {
  id: string;
  setupWizard?: ChannelPlugin["setupWizard"];
  config: Record<string, unknown>;
} & Record<string, unknown>;
declare function createSetupWizardAdapter(params: SetupWizardAdapterParams): ChannelSetupWizardAdapter;
declare function createPluginSetupWizardAdapter(plugin: SetupWizardTestPlugin): ChannelSetupWizardAdapter;
declare function createPluginSetupWizardConfigure(plugin: SetupWizardTestPlugin): (ctx: ChannelSetupConfigureContext) => Promise<ChannelSetupResult>;
declare function createPluginSetupWizardStatus(plugin: SetupWizardTestPlugin): (ctx: ChannelSetupStatusContext) => Promise<ChannelSetupStatus>;
declare function runSetupWizardConfigure<TCfg, TOptions extends Record<string, unknown>, TAccountOverrides extends Record<string, string | undefined>, TRuntime, TResult>(params: {
  configure: (args: {
    cfg: TCfg;
    runtime: TRuntime;
    prompter: WizardPrompter;
    options: TOptions;
    accountOverrides: TAccountOverrides;
    shouldPromptAccountIds: boolean;
    forceAllowFrom: boolean;
  }) => Promise<TResult>;
  cfg?: TCfg;
  runtime?: TRuntime;
  prompter: WizardPrompter;
  options?: TOptions;
  accountOverrides?: TAccountOverrides;
  shouldPromptAccountIds?: boolean;
  forceAllowFrom?: boolean;
}): Promise<TResult>;
declare function runSetupWizardPrepare<TCfg, TOptions extends Record<string, unknown>, TRuntime, TResult>(params: {
  prepare?: (args: {
    cfg: TCfg;
    accountId: string;
    credentialValues: Record<string, string>;
    runtime: TRuntime;
    prompter: WizardPrompter;
    options?: TOptions;
  }) => Promise<TResult> | TResult;
  cfg?: TCfg;
  accountId?: string;
  credentialValues?: Record<string, string>;
  runtime?: TRuntime;
  prompter?: WizardPrompter;
  options?: TOptions;
}): Promise<TResult | undefined>;
declare function runSetupWizardFinalize<TCfg, TOptions extends Record<string, unknown>, TRuntime, TResult>(params: {
  finalize?: (args: {
    cfg: TCfg;
    accountId: string;
    credentialValues: Record<string, string>;
    runtime: TRuntime;
    prompter: WizardPrompter;
    options?: TOptions;
    forceAllowFrom: boolean;
  }) => Promise<TResult> | TResult;
  cfg?: TCfg;
  accountId?: string;
  credentialValues?: Record<string, string>;
  runtime?: TRuntime;
  prompter?: WizardPrompter;
  options?: TOptions;
  forceAllowFrom?: boolean;
}): Promise<TResult | undefined>;
declare function promptSetupWizardAllowFrom<TCfg, TResult>(params: {
  promptAllowFrom?: (args: {
    cfg: TCfg;
    prompter: WizardPrompter;
    accountId: string;
  }) => Promise<TResult> | TResult;
  cfg?: TCfg;
  prompter?: WizardPrompter;
  accountId?: string;
}): Promise<TResult | undefined>;
declare function resolveSetupWizardAllowFromEntries<TCfg, TResult>(params: {
  resolveEntries?: (args: {
    cfg: TCfg;
    accountId: string;
    credentialValues: Record<string, string>;
    entries: string[];
  }) => Promise<TResult> | TResult;
  entries: string[];
  cfg?: TCfg;
  accountId?: string;
  credentialValues?: SetupWizardCredentialValues;
}): Promise<TResult | undefined>;
declare function resolveSetupWizardGroupAllowlist<TCfg, TResult>(params: {
  resolveAllowlist?: (args: {
    cfg: TCfg;
    accountId: string;
    credentialValues: Record<string, string>;
    entries: string[];
    prompter: Pick<WizardPrompter, "note">;
  }) => Promise<TResult> | TResult;
  entries: string[];
  cfg?: TCfg;
  accountId?: string;
  credentialValues?: SetupWizardCredentialValues;
  prompter?: Pick<WizardPrompter, "note">;
}): Promise<TResult | undefined>;
//#endregion
//#region src/plugins/api-builder.d.ts
type BuildPluginApiParams = {
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
declare function buildPluginApi(params: BuildPluginApiParams): OpenClawPluginApi;
//#endregion
//#region src/plugins/runtime/runtime-taskflow.d.ts
declare function createRuntimeTaskFlow(): PluginRuntimeTaskFlow;
//#endregion
export { setDefaultChannelPluginRegistryForTests as $, resolveProviderWizardOptions as A, resetPluginRuntimeStateForTest as B, registerSingleProviderPlugin as C, resolveProviderPluginChoice as D, createTestRegistry as E, createCapturedPluginRegistration as F, addTestHook as G, resolveBundledExplicitWebFetchProvidersFromPublicArtifacts as H, resetFacadeRuntimeStateForTest as I, pluginRegistrationContractRegistry as J, createMockPluginRegistry as K, listImportedBundledPluginFacadeIds as L, runProviderCatalog as M, CapturedPluginRegistration as N, buildProviderPluginMethodChoice as O, capturePluginRegistration as P, resolveWebSearchProviderContractEntriesForPluginId as Q, getActivePluginRegistry as R, registerProviderPlugins as S, createOutboundTestPlugin as T, resolveBundledExplicitWebSearchProvidersFromPublicArtifacts as U, setActivePluginRegistry as V, createPluginRecord as W, resolveProviderContractProvidersForPluginIds as X, providerContractLoadError as Y, resolveWebFetchProviderContractEntriesForPluginId as Z, createNonExitingTypedRuntimeEnv as _, createPluginSetupWizardStatus as a, RegisteredProviderCollections as b, createTestWizardPrompter as c, resolveSetupWizardGroupAllowlist as d, ChannelMessageActionName as et, runSetupWizardConfigure as f, createNonExitingRuntimeEnv as g, selectFirstWizardOption as h, createPluginSetupWizardConfigure as i, setProviderWizardProvidersResolverForTest as j, resolveProviderModelPickerEntries as k, promptSetupWizardAllowFrom as l, runSetupWizardPrepare as m, buildPluginApi as n, createQueuedWizardPrompter as o, runSetupWizardFinalize as p, resolveBundledExplicitProviderContractsFromPublicArtifacts as q, createPluginSetupWizardAdapter as r, createSetupWizardAdapter as s, createRuntimeTaskFlow as t, resolveSetupWizardAllowFromEntries as u, createRuntimeEnv as v, requireRegisteredProvider as w, registerProviderPlugin as x, createTypedRuntimeEnv as y, releasePinnedPluginChannelRegistry as z };