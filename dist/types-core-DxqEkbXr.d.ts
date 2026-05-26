import { i as OpenClawConfig, t as ConfigFileSnapshot } from "./types.openclaw-BLF4DJTX.js";
import { O as SessionMaintenanceMode } from "./types.base-DS--yneR.js";
import { o as SsrFPolicy } from "./ssrf-skjEI_i5.js";
import { t as ModelProviderRequestTransportOverrides } from "./provider-request-config-Ckb2OLir.js";
import { n as requestHeartbeat, t as HeartbeatRunResult } from "./heartbeat-wake-B5gXOqCt.js";
import { t as ConfigWriteAfterWrite } from "./runtime-snapshot-DFYNlVNW.js";
import { S as ConfigReplaceResult, m as ConfigMutationBase } from "./config-BATvkw_w.js";
import { y as resolveStateDir } from "./paths-h7O2WRLI.js";
import { i as ThinkingCatalogEntry, r as ThinkLevel } from "./thinking.shared-DZFlsfdo.js";
import { h as EmbeddedPiRunResult, r as RunEmbeddedPiAgentParams } from "./params-C8lj3xSa.js";
import { o as ChannelRouteRef } from "./channel-route-BCPDrLfB.js";
import { t as DeliveryContext } from "./delivery-context.types-DsJXWtUi.js";
import { o as SessionEntry, r as GroupKeyResolution } from "./types-ChLEnNVH.js";
import { t as FallbackAttempt } from "./model-fallback.types-B2o5-mGE.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-6FEupg54.js";
import { M as resolveAgentDir, N as resolveAgentWorkspaceDir } from "./agent-scope-DxE-spFK.js";
import { n as resolveAgentIdentity } from "./identity-Bfzgm43w.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-LYni1Yjz.js";
import { n as ensureAgentWorkspace } from "./workspace-DY9Fuin-.js";
import { c as updateSessionStore, f as loadSessionStore, h as resolveSessionFilePath, l as updateSessionStoreEntry, n as listSessionEntries, r as patchSessionEntry, t as getSessionEntry, u as upsertSessionEntry, v as resolveStorePath } from "./store-hrETKlw2.js";
import { s as AuthProfileStore } from "./types-BwDj5PsX.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";
import { o as enqueueSystemEvent } from "./system-events-Bj2zUqf7.js";
import { a as runCommandWithTimeout } from "./exec-BGPm1RPN.js";
import { s as mediaKindFromMime } from "./constants-Bjv4FoLj.js";
import { f as resizeToJpeg, s as getImageMetadata } from "./image-ops-xNaOYvkf.js";
import { n as loadWebMedia } from "./web-media-_zAASF_z.js";
import { n as detectMime } from "./mime-Ds6Fkh-A.js";
import { r as isVoiceCompatibleAudio } from "./audio-DEAA6ir8.js";
import { _ as ImageGenerationSourceImage, c as ImageGenerationOutputFormat, f as ImageGenerationProviderOptions, h as ImageGenerationResolution, i as ImageGenerationNormalization, l as ImageGenerationProvider, n as ImageGenerationBackground, p as ImageGenerationQuality, r as ImageGenerationIgnoredOverride, t as GeneratedImageAsset } from "./types-BaGDaXQN.js";
import { d as VideoGenerationResolution, n as VideoGenerationIgnoredOverride, o as VideoGenerationNormalization, p as VideoGenerationSourceAsset, s as VideoGenerationProvider, t as GeneratedVideoAsset } from "./types-Dcgt3eyW.js";
import { c as MusicGenerationProvider, f as MusicGenerationSourceImage, o as MusicGenerationNormalization, r as MusicGenerationIgnoredOverride, s as MusicGenerationOutputFormat, t as GeneratedMusicAsset } from "./types-M_PrR5fi.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
import { n as RuntimeWebSearchMetadata, t as RuntimeWebFetchMetadata } from "./runtime-web-tools.types-Co2KBj4w.js";
import { i as WizardPrompter } from "./prompts-DgKIGa-v.js";
import { t as SecretInputMode } from "./provider-auth-types-C72FsWut.js";
import { a as onAgentEvent } from "./agent-events-DtKTaaH3.js";
import { a as shouldLogVerbose } from "./globals-BL1_NohW.js";
import { a as TaskRegistrySummary, c as TaskScopeKind, d as TaskTerminalOutcome, i as TaskRecord, l as TaskStatus, n as TaskDeliveryStatus, o as TaskRuntime, r as TaskNotifyPolicy, s as TaskRuntimeCounts, t as TaskDeliveryState, u as TaskStatusCounts } from "./task-registry.types-CicKx6sv.js";
import { n as TaskFlowRecord, r as TaskFlowStatus, t as JsonValue } from "./task-flow-registry.types-Dn4kjE5t.js";
import { r as AnyAgentTool } from "./common-BDN0bXby.js";
import { t as HookEntry } from "./types-BCpQVPCb.js";
import { n as LogLevel } from "./levels-561AeL30.js";
import { a as MediaUnderstandingRuntime } from "./runtime-types-C5ygRBi_.js";
import { i as TextToSpeechTelephony, n as TextToSpeech, r as TextToSpeechStream, t as ListSpeechVoices } from "./tts-runtime.types-DsGX4LDs.js";
import { TSchema } from "typebox";

//#region src/agents/timeout.d.ts
declare function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
}): number;
//#endregion
//#region src/config/sessions/runtime-types.d.ts
type ReadSessionUpdatedAt = (params: {
  storePath: string;
  sessionKey: string;
}) => number | undefined;
type SessionMaintenanceWarningRuntime = {
  activeSessionKey: string;
  activeUpdatedAt?: number;
  totalEntries: number;
  pruneAfterMs: number;
  maxEntries: number;
  wouldPrune: boolean;
  wouldCap: boolean;
};
type ResolvedSessionMaintenanceConfigRuntime = {
  mode: SessionMaintenanceMode;
  pruneAfterMs: number;
  maxEntries: number;
  resetArchiveRetentionMs: number | null;
  maxDiskBytes: number | null;
  highWaterBytes: number | null;
};
type SessionMaintenanceApplyReportRuntime = {
  mode: SessionMaintenanceMode;
  beforeCount: number;
  afterCount: number;
  pruned: number;
  capped: number;
  diskBudget: Record<string, unknown> | null;
};
type SaveSessionStoreOptions = {
  skipMaintenance?: boolean;
  activeSessionKey?: string;
  allowDropAcpMetaSessionKeys?: string[];
  onWarn?: (warning: SessionMaintenanceWarningRuntime) => void | Promise<void>;
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReportRuntime) => void | Promise<void>;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfigRuntime>;
};
type SaveSessionStore = (storePath: string, store: Record<string, SessionEntry>, opts?: SaveSessionStoreOptions) => Promise<void>;
type RecordSessionMetaFromInbound = (params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}) => Promise<SessionEntry | null>;
type UpdateLastRoute = (params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}) => Promise<SessionEntry | null>;
//#endregion
//#region src/plugins/runtime/native-deps.d.ts
type NativeDependencyHintParams = {
  packageName: string;
  manager?: "pnpm" | "npm" | "yarn";
  rebuildCommand?: string;
  approveBuildsCommand?: string;
  downloadCommand?: string;
};
declare function formatNativeDependencyHint(params: NativeDependencyHintParams): string;
//#endregion
//#region src/image-generation/runtime-types.d.ts
type GenerateImageParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageGenerationOutputFormat;
  background?: ImageGenerationBackground;
  inputImages?: ImageGenerationSourceImage[];
  autoProviderFallback?: boolean; /** Optional per-request provider timeout in milliseconds. */
  timeoutMs?: number;
  providerOptions?: ImageGenerationProviderOptions; /** SSRF policy to propagate into image-generation provider HTTP calls. */
  ssrfPolicy?: SsrFPolicy;
};
type GenerateImageRuntimeResult = {
  images: GeneratedImageAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  normalization?: ImageGenerationNormalization;
  metadata?: Record<string, unknown>;
  ignoredOverrides: ImageGenerationIgnoredOverride[];
};
type ListRuntimeImageGenerationProvidersParams = {
  config?: OpenClawConfig;
};
type RuntimeImageGenerationProvider = ImageGenerationProvider;
//#endregion
//#region src/video-generation/runtime-types.d.ts
type GenerateVideoParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImages?: VideoGenerationSourceAsset[];
  inputVideos?: VideoGenerationSourceAsset[];
  inputAudios?: VideoGenerationSourceAsset[];
  autoProviderFallback?: boolean; /** Arbitrary provider-specific options forwarded as-is to provider.generateVideo. */
  providerOptions?: Record<string, unknown>; /** Optional per-request provider timeout in milliseconds. */
  timeoutMs?: number;
};
type GenerateVideoRuntimeResult = {
  videos: GeneratedVideoAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  normalization?: VideoGenerationNormalization;
  metadata?: Record<string, unknown>;
  ignoredOverrides: VideoGenerationIgnoredOverride[];
};
type ListRuntimeVideoGenerationProvidersParams = {
  config?: OpenClawConfig;
};
type RuntimeVideoGenerationProvider = VideoGenerationProvider;
//#endregion
//#region src/music-generation/runtime-types.d.ts
type GenerateMusicParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  inputImages?: MusicGenerationSourceImage[];
  autoProviderFallback?: boolean; /** Optional per-request provider timeout in milliseconds. */
  timeoutMs?: number;
};
type GenerateMusicRuntimeResult = {
  tracks: GeneratedMusicAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  lyrics?: string[];
  normalization?: MusicGenerationNormalization;
  metadata?: Record<string, unknown>;
  ignoredOverrides: MusicGenerationIgnoredOverride[];
};
type ListRuntimeMusicGenerationProvidersParams = {
  config?: OpenClawConfig;
};
type RuntimeMusicGenerationProvider = MusicGenerationProvider;
//#endregion
//#region src/plugins/web-provider-types.d.ts
type WebSearchProviderId = string;
type WebFetchProviderId = string;
type WebSearchProviderToolDefinition = {
  description: string;
  parameters: TSchema;
  execute: (args: Record<string, unknown>, context?: WebSearchProviderToolExecutionContext) => Promise<Record<string, unknown>>;
};
type WebFetchProviderToolDefinition = {
  description: string;
  parameters: TSchema;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
type WebSearchProviderContext = {
  config?: OpenClawConfig;
  searchConfig?: Record<string, unknown>;
  runtimeMetadata?: RuntimeWebSearchMetadata;
  agentDir?: string;
};
type WebSearchProviderToolExecutionContext = {
  signal?: AbortSignal;
};
type WebFetchProviderContext = {
  config?: OpenClawConfig;
  fetchConfig?: Record<string, unknown>;
  runtimeMetadata?: RuntimeWebFetchMetadata;
};
type WebSearchCredentialResolutionSource = "config" | "secretRef" | "env" | "missing";
type WebSearchProviderConfiguredCredentialFallback = {
  path: string;
  value: unknown;
};
type WebFetchProviderConfiguredCredentialFallback = {
  path: string;
  value: unknown;
};
type WebSearchRuntimeMetadataContext = {
  config?: OpenClawConfig;
  searchConfig?: Record<string, unknown>;
  runtimeMetadata?: RuntimeWebSearchMetadata;
  resolvedCredential?: {
    value?: string;
    source: WebSearchCredentialResolutionSource;
    fallbackEnvVar?: string;
  };
};
type WebSearchProviderSetupContext = {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  quickstartDefaults?: boolean;
  secretInputMode?: SecretInputMode;
};
type WebFetchCredentialResolutionSource = "config" | "secretRef" | "env" | "missing";
type WebFetchRuntimeMetadataContext = {
  config?: OpenClawConfig;
  fetchConfig?: Record<string, unknown>;
  runtimeMetadata?: RuntimeWebFetchMetadata;
  resolvedCredential?: {
    value?: string;
    source: WebFetchCredentialResolutionSource;
    fallbackEnvVar?: string;
  };
};
type WebSearchProviderPlugin = {
  id: WebSearchProviderId;
  label: string;
  hint: string;
  onboardingScopes?: readonly "text-inference"[];
  requiresCredential?: boolean;
  credentialLabel?: string;
  envVars: string[]; /** Optional model-provider auth profile id that can satisfy this web provider without a tool-specific API key. */
  authProviderId?: string;
  placeholder: string;
  signupUrl: string;
  docsUrl?: string; /** Optional note shown before credential collection for provider-specific prerequisites. */
  credentialNote?: string;
  autoDetectOrder?: number;
  credentialPath: string;
  inactiveSecretPaths?: string[];
  getCredentialValue: (searchConfig?: Record<string, unknown>) => unknown;
  setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => void;
  getConfiguredCredentialValue?: (config?: OpenClawConfig) => unknown;
  setConfiguredCredentialValue?: (configTarget: OpenClawConfig, value: unknown) => void;
  getConfiguredCredentialFallback?: (config?: OpenClawConfig) => WebSearchProviderConfiguredCredentialFallback | undefined;
  applySelectionConfig?: (config: OpenClawConfig) => OpenClawConfig;
  runSetup?: (ctx: WebSearchProviderSetupContext) => OpenClawConfig | Promise<OpenClawConfig>;
  resolveRuntimeMetadata?: (ctx: WebSearchRuntimeMetadataContext) => Partial<RuntimeWebSearchMetadata> | Promise<Partial<RuntimeWebSearchMetadata>>;
  createTool: (ctx: WebSearchProviderContext) => WebSearchProviderToolDefinition | null;
};
type PluginWebSearchProviderEntry = WebSearchProviderPlugin & {
  pluginId: string;
};
type WebFetchProviderPlugin = {
  id: WebFetchProviderId;
  label: string;
  hint: string;
  requiresCredential?: boolean;
  credentialLabel?: string;
  envVars: string[];
  placeholder: string;
  signupUrl: string;
  docsUrl?: string;
  autoDetectOrder?: number;
  credentialPath: string;
  inactiveSecretPaths?: string[];
  getCredentialValue: (fetchConfig?: Record<string, unknown>) => unknown;
  setCredentialValue: (fetchConfigTarget: Record<string, unknown>, value: unknown) => void;
  getConfiguredCredentialValue?: (config?: OpenClawConfig) => unknown;
  setConfiguredCredentialValue?: (configTarget: OpenClawConfig, value: unknown) => void;
  getConfiguredCredentialFallback?: (config?: OpenClawConfig) => WebFetchProviderConfiguredCredentialFallback | undefined;
  applySelectionConfig?: (config: OpenClawConfig) => OpenClawConfig;
  resolveRuntimeMetadata?: (ctx: WebFetchRuntimeMetadataContext) => Partial<RuntimeWebFetchMetadata> | Promise<Partial<RuntimeWebFetchMetadata>>;
  createTool: (ctx: WebFetchProviderContext) => WebFetchProviderToolDefinition | null;
};
type PluginWebFetchProviderEntry = WebFetchProviderPlugin & {
  pluginId: string;
};
//#endregion
//#region src/web-search/runtime-types.d.ts
type ResolveWebSearchDefinitionParams = {
  config?: OpenClawConfig;
  agentDir?: string;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
  preferInputConfig?: boolean;
};
type RunWebSearchParams = ResolveWebSearchDefinitionParams & {
  args: Record<string, unknown>;
  signal?: AbortSignal;
};
type RunWebSearchResult = {
  provider: string;
  result: Record<string, unknown>;
};
type ListWebSearchProvidersParams = {
  config?: OpenClawConfig;
};
type RuntimeWebSearchProviderEntry = PluginWebSearchProviderEntry;
//#endregion
//#region src/sessions/transcript-events.d.ts
type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};
type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;
declare function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void;
declare function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void;
//#endregion
//#region src/plugin-state/plugin-state-store.types.d.ts
type PluginStateEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
  expiresAt?: number;
};
type PluginStateKeyedStore<T> = {
  register(key: string, value: T, opts?: {
    ttlMs?: number;
  }): Promise<void>;
  registerIfAbsent(key: string, value: T, opts?: {
    ttlMs?: number;
  }): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
  consume(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<PluginStateEntry<T>[]>;
  clear(): Promise<void>;
};
type OpenKeyedStoreOptions = {
  namespace: string;
  maxEntries: number;
  defaultTtlMs?: number;
};
//#endregion
//#region src/agents/tool-fs-policy.types.d.ts
type ToolFsPolicy = {
  workspaceOnly: boolean;
};
//#endregion
//#region src/plugins/tool-types.d.ts
type OpenClawPluginActiveModelContext = {
  provider?: string;
  modelId?: string;
  modelRef?: string;
};
/** Trusted execution context passed to plugin-owned agent tool factories. */
type OpenClawPluginToolContext = {
  config?: OpenClawConfig; /** Active runtime-resolved config snapshot when one is available. */
  runtimeConfig?: OpenClawConfig; /** Returns the latest runtime-resolved config snapshot for long-lived tool definitions. */
  getRuntimeConfig?: () => OpenClawConfig | undefined; /** Effective filesystem policy for the active tool run. */
  fsPolicy?: ToolFsPolicy;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string; /** Ephemeral session UUID - regenerated on /new and /reset. Use for per-conversation isolation. */
  sessionId?: string;
  /**
   * Runtime-supplied active model metadata for informational use, diagnostics,
   * and plugin-owned policy decisions. This is not a security boundary against
   * the local operator, installed plugin code, or a modified OpenClaw runtime.
   */
  activeModel?: OpenClawPluginActiveModelContext;
  browser?: {
    sandboxBridgeUrl?: string;
    allowHostControl?: boolean;
  };
  messageChannel?: string;
  agentAccountId?: string; /** Trusted provider auth availability from the active auth profile store. */
  hasAuthForProvider?: (providerId: string) => boolean; /** Resolves an API key from the active auth profile store when available. */
  resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>; /** Trusted ambient delivery route for the active agent/session. */
  deliveryContext?: DeliveryContext; /** Trusted sender id from inbound context (runtime-provided, not tool args). */
  requesterSenderId?: string;
  sandboxed?: boolean;
};
type OpenClawPluginToolFactory = (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined;
type OpenClawPluginToolOptions = {
  name?: string;
  names?: string[];
  optional?: boolean;
};
type OpenClawPluginHookOptions = {
  entry?: HookEntry;
  name?: string;
  description?: string;
  register?: boolean;
};
//#endregion
//#region src/plugins/runtime/runtime-taskflow.types.d.ts
type ManagedTaskFlowRecord = TaskFlowRecord & {
  syncMode: "managed";
  controllerId: string;
};
type ManagedTaskFlowMutationErrorCode = "not_found" | "not_managed" | "revision_conflict";
type ManagedTaskFlowMutationResult = {
  applied: true;
  flow: ManagedTaskFlowRecord;
} | {
  applied: false;
  code: ManagedTaskFlowMutationErrorCode;
  current?: TaskFlowRecord;
};
type BoundTaskFlowTaskRunResult = {
  created: true;
  flow: ManagedTaskFlowRecord;
  task: TaskRecord;
} | {
  created: false;
  reason: string;
  found: boolean;
  flow?: TaskFlowRecord;
};
type BoundTaskFlowCancelResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  tasks?: TaskRecord[];
};
type BoundTaskFlowRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  createManaged: (params: {
    controllerId: string;
    goal: string;
    status?: ManagedTaskFlowRecord["status"];
    notifyPolicy?: TaskNotifyPolicy;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    cancelRequestedAt?: number | null;
    createdAt?: number;
    updatedAt?: number;
    endedAt?: number | null;
  }) => ManagedTaskFlowRecord;
  get: (flowId: string) => TaskFlowRecord | undefined;
  list: () => TaskFlowRecord[];
  findLatest: () => TaskFlowRecord | undefined;
  resolve: (token: string) => TaskFlowRecord | undefined;
  getTaskSummary: (flowId: string) => TaskRegistrySummary | undefined;
  setWaiting: (params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  resume: (params: {
    flowId: string;
    expectedRevision: number;
    status?: Extract<ManagedTaskFlowRecord["status"], "queued" | "running">;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  finish: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  fail: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  requestCancel: (params: {
    flowId: string;
    expectedRevision: number;
    cancelRequestedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  cancel: (params: {
    flowId: string;
    cfg: OpenClawConfig;
  }) => Promise<BoundTaskFlowCancelResult>;
  runTask: (params: {
    flowId: string;
    runtime: TaskRuntime;
    sourceId?: string;
    childSessionKey?: string;
    parentTaskId?: string;
    agentId?: string;
    runId?: string;
    label?: string;
    task: string;
    preferMetadata?: boolean;
    notifyPolicy?: TaskNotifyPolicy;
    deliveryStatus?: TaskDeliveryStatus;
    status?: "queued" | "running";
    startedAt?: number;
    lastEventAt?: number;
    progressSummary?: string | null;
  }) => BoundTaskFlowTaskRunResult;
};
type PluginRuntimeTaskFlow = {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskFlowRuntime;
  fromToolContext: (ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">) => BoundTaskFlowRuntime;
};
//#endregion
//#region src/agents/model-auth-runtime-shared.d.ts
type ResolvedProviderAuth = {
  apiKey?: string;
  profileId?: string;
  source: string;
  mode: "api-key" | "oauth" | "token" | "aws-sdk";
};
declare function resolveAwsSdkEnvVarName(env?: NodeJS.ProcessEnv): string | undefined;
declare function formatMissingAuthError(auth: ResolvedProviderAuth, provider: string): string;
declare function requireApiKey(auth: ResolvedProviderAuth, provider: string): string;
//#endregion
//#region src/plugins/runtime/model-auth-types.d.ts
/**
 * Runtime-ready auth result exposed to native plugins and context engines.
 *
 * `source`, `mode`, and `profileId` describe how the original credential was
 * resolved. `apiKey` is the request-ready credential after any provider-owned
 * runtime exchange, so it may differ from the stored/raw credential.
 */
type ResolvedProviderRuntimeAuth = Omit<ResolvedProviderAuth, "apiKey"> & {
  apiKey?: string;
  baseUrl?: string;
  request?: ModelProviderRequestTransportOverrides;
  expiresAt?: number;
};
//#endregion
//#region src/plugins/runtime/task-domain-types.d.ts
type TaskRunAggregateSummary = {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byStatus: TaskStatusCounts;
  byRuntime: TaskRuntimeCounts;
};
type TaskRunView = {
  id: string;
  runtime: TaskRuntime;
  sourceId?: string;
  sessionKey: string;
  ownerKey: string;
  scope: TaskScopeKind;
  childSessionKey?: string;
  flowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  title: string;
  status: TaskStatus;
  deliveryStatus: TaskDeliveryStatus;
  notifyPolicy: TaskNotifyPolicy;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskTerminalOutcome;
};
type TaskRunDetail = TaskRunView;
type TaskRunCancelResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  task?: TaskRunDetail;
};
type TaskFlowView = {
  id: string;
  ownerKey: string;
  requesterOrigin?: DeliveryContext;
  status: TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};
type TaskFlowDetail = TaskFlowView & {
  state?: JsonValue;
  wait?: JsonValue;
  blocked?: {
    taskId?: string;
    summary?: string;
  };
  tasks: TaskRunView[];
  taskSummary: TaskRunAggregateSummary;
};
//#endregion
//#region src/plugins/runtime/runtime-tasks.types.d.ts
type BoundTaskRunsRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  get: (taskId: string) => TaskRunDetail | undefined;
  list: () => TaskRunView[];
  findLatest: () => TaskRunDetail | undefined;
  resolve: (token: string) => TaskRunDetail | undefined;
  cancel: (params: {
    taskId: string;
    cfg: OpenClawConfig;
  }) => Promise<TaskRunCancelResult>;
};
type PluginRuntimeTaskRuns = {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskRunsRuntime;
  fromToolContext: (ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">) => BoundTaskRunsRuntime;
};
type BoundTaskFlowsRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  get: (flowId: string) => TaskFlowDetail | undefined;
  list: () => TaskFlowView[];
  findLatest: () => TaskFlowDetail | undefined;
  resolve: (token: string) => TaskFlowDetail | undefined;
  getTaskSummary: (flowId: string) => TaskRunAggregateSummary | undefined;
};
type PluginRuntimeTaskFlows = {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskFlowsRuntime;
  fromToolContext: (ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">) => BoundTaskFlowsRuntime;
};
type PluginRuntimeTasks = {
  runs: PluginRuntimeTaskRuns;
  flows: PluginRuntimeTaskFlows;
  managedFlows: PluginRuntimeTaskFlow; /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
  flow: PluginRuntimeTaskFlow;
};
//#endregion
//#region src/plugins/runtime/types-core.d.ts
type RuntimeRequestHeartbeatOptions = Parameters<typeof requestHeartbeat>[0];
type RuntimeRequestHeartbeatNowOptions = Omit<RuntimeRequestHeartbeatOptions, "source" | "intent"> & Partial<Pick<RuntimeRequestHeartbeatOptions, "source" | "intent">>;
type RuntimeWriteConfigOptions = {
  envSnapshotForRestore?: Record<string, string | undefined>;
  expectedConfigPath?: string;
  unsetPaths?: string[][];
};
type DeepReadonly<T> = T extends ((...args: never[]) => unknown) ? T : T extends readonly (infer U)[] ? ReadonlyArray<DeepReadonly<U>> : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type RuntimeConfigAfterWrite = ConfigWriteAfterWrite;
type RuntimeConfigReplaceResult = ConfigReplaceResult;
type RuntimeConfigMutationBase = ConfigMutationBase;
type RuntimeConfigMutationContext = {
  snapshot: ConfigFileSnapshot;
  previousHash: string | null;
};
type RuntimeMutateConfigFileParams<T = void> = {
  base?: RuntimeConfigMutationBase;
  baseHash?: string;
  afterWrite: RuntimeConfigAfterWrite;
  writeOptions?: RuntimeWriteConfigOptions;
  mutate: (draft: OpenClawConfig, context: RuntimeConfigMutationContext) => Promise<T | void> | T | void;
};
type RuntimeReplaceConfigFileParams = {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  afterWrite: RuntimeConfigAfterWrite;
  writeOptions?: RuntimeWriteConfigOptions;
};
type PluginRuntimeThinkingPolicyRequest = {
  provider?: string | null;
  model?: string | null;
  catalog?: ThinkingCatalogEntry[];
};
type PluginRuntimeThinkingPolicyLevel = {
  id: ThinkLevel;
  label: string;
};
type PluginRuntimeThinkingPolicy = {
  levels: PluginRuntimeThinkingPolicyLevel[];
  defaultLevel?: ThinkLevel | null;
};
/** Structured logger surface injected into runtime-backed plugin helpers. */
type RuntimeLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};
type RunHeartbeatOnceOptions = {
  reason?: string;
  agentId?: string;
  sessionKey?: string; /** Override heartbeat config (e.g. `{ target: "last" }` to deliver to the last active channel). */
  heartbeat?: {
    target?: string;
  };
};
type LlmCompleteMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
type LlmCompleteCaller = {
  kind: "plugin" | "context-engine" | "host" | "unknown";
  id?: string;
  name?: string;
};
type LlmCompleteUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};
type LlmCompleteParams = {
  messages: LlmCompleteMessage[]; /** Model ref (e.g. "anthropic/claude-sonnet-4-6"); defaults to the target agent's configured model. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  signal?: AbortSignal; /** Human-readable reason for audit/debug output. */
  purpose?: string; /** Agent whose model/credentials to use. Session-bound capabilities may disallow overrides. */
  agentId?: string;
};
type LlmCompleteResult = {
  text: string;
  provider: string;
  model: string;
  agentId: string;
  usage: LlmCompleteUsage;
  audit: {
    caller: LlmCompleteCaller;
    purpose?: string;
    sessionKey?: string;
  };
};
type RuntimeRunEmbeddedPiAgent = (params: RunEmbeddedPiAgentParams) => Promise<EmbeddedPiRunResult>;
/** Core runtime helpers exposed to trusted native plugins. */
type PluginRuntimeCore = {
  version: string;
  config: {
    /** Current process runtime config snapshot. Prefer config passed into the active call path. */current: () => DeepReadonly<OpenClawConfig>;
    /**
     * Persist a focused config mutation. Callers must choose the post-write
     * behavior explicitly so the gateway can hot-reload, restart, or defer.
     */
    mutateConfigFile: <T = void>(params: RuntimeMutateConfigFileParams<T>) => Promise<RuntimeConfigReplaceResult & {
      result: T | undefined;
    }>;
    /**
     * Persist a full config replacement. Callers must choose the post-write
     * behavior explicitly so the gateway can hot-reload, restart, or defer.
     */
    replaceConfigFile: (params: RuntimeReplaceConfigFileParams) => Promise<RuntimeConfigReplaceResult>;
    /**
     * @deprecated Use current(), or pass the already loaded config through the
     * call path. Runtime code must not reload config on demand. Bundled
     * plugins and repo code are blocked from using this by the
     * deprecated-internal-config-api architecture guard.
     */
    loadConfig: () => OpenClawConfig;
    /**
     * @deprecated Use mutateConfigFile() or replaceConfigFile() with an
     * explicit afterWrite intent so restart behavior stays under host control.
     * Bundled plugins and repo code are blocked from using this by the
     * deprecated-internal-config-api architecture guard.
     */
    writeConfigFile: (cfg: OpenClawConfig, options?: RuntimeWriteConfigOptions & {
      afterWrite?: RuntimeConfigAfterWrite;
    }) => Promise<void>;
  };
  agent: {
    defaults: {
      model: typeof DEFAULT_MODEL;
      provider: typeof DEFAULT_PROVIDER;
    };
    resolveAgentDir: typeof resolveAgentDir;
    resolveAgentWorkspaceDir: typeof resolveAgentWorkspaceDir;
    resolveAgentIdentity: typeof resolveAgentIdentity;
    resolveThinkingDefault: (params: {
      cfg: OpenClawConfig;
      provider: string;
      model: string;
      catalog?: ModelCatalogEntry[];
    }) => ThinkLevel;
    normalizeThinkingLevel: (raw?: string | null) => ThinkLevel | undefined;
    resolveThinkingPolicy: (params: PluginRuntimeThinkingPolicyRequest) => PluginRuntimeThinkingPolicy;
    runEmbeddedAgent: RuntimeRunEmbeddedPiAgent;
    runEmbeddedPiAgent: RuntimeRunEmbeddedPiAgent;
    resolveAgentTimeoutMs: typeof resolveAgentTimeoutMs;
    ensureAgentWorkspace: typeof ensureAgentWorkspace;
    session: {
      resolveStorePath: typeof resolveStorePath;
      getSessionEntry: typeof getSessionEntry;
      listSessionEntries: typeof listSessionEntries;
      patchSessionEntry: typeof patchSessionEntry;
      upsertSessionEntry: typeof upsertSessionEntry;
      /**
       * @deprecated Use getSessionEntry/listSessionEntries for reads and
       * patchSessionEntry/upsertSessionEntry for writes. This keeps the legacy
       * mutable whole-store compatibility shape.
       */
      loadSessionStore: typeof loadSessionStore;
      saveSessionStore: SaveSessionStore;
      updateSessionStore: typeof updateSessionStore;
      updateSessionStoreEntry: typeof updateSessionStoreEntry;
      resolveSessionFilePath: typeof resolveSessionFilePath;
    };
  };
  system: {
    enqueueSystemEvent: typeof enqueueSystemEvent;
    requestHeartbeat: typeof requestHeartbeat;
    /**
     * @deprecated Use `requestHeartbeat({ source, intent, reason })` so wake producers declare
     * scheduler intent explicitly.
     */
    requestHeartbeatNow: (opts?: RuntimeRequestHeartbeatNowOptions) => void;
    /**
     * Run a single heartbeat cycle immediately (bypassing the coalesce timer).
     * Accepts an optional `heartbeat` config override so callers can force
     * delivery to the last active channel — the same pattern the cron service
     * uses to avoid the default `target: "none"` suppression.
     */
    runHeartbeatOnce: (opts?: RunHeartbeatOnceOptions) => Promise<HeartbeatRunResult>;
    runCommandWithTimeout: typeof runCommandWithTimeout;
    formatNativeDependencyHint: typeof formatNativeDependencyHint;
  };
  media: {
    loadWebMedia: typeof loadWebMedia;
    detectMime: typeof detectMime;
    mediaKindFromMime: typeof mediaKindFromMime;
    isVoiceCompatibleAudio: typeof isVoiceCompatibleAudio;
    getImageMetadata: typeof getImageMetadata;
    resizeToJpeg: typeof resizeToJpeg;
  };
  tts: {
    textToSpeech: TextToSpeech;
    textToSpeechStream: TextToSpeechStream;
    textToSpeechTelephony: TextToSpeechTelephony;
    listVoices: ListSpeechVoices;
  };
  mediaUnderstanding: {
    runFile: MediaUnderstandingRuntime["runMediaUnderstandingFile"];
    describeImageFile: MediaUnderstandingRuntime["describeImageFile"];
    describeImageFileWithModel: MediaUnderstandingRuntime["describeImageFileWithModel"];
    extractStructuredWithModel: MediaUnderstandingRuntime["extractStructuredWithModel"];
    describeVideoFile: MediaUnderstandingRuntime["describeVideoFile"];
    transcribeAudioFile: MediaUnderstandingRuntime["transcribeAudioFile"];
  };
  imageGeneration: {
    generate: (params: GenerateImageParams) => Promise<GenerateImageRuntimeResult>;
    listProviders: (params?: ListRuntimeImageGenerationProvidersParams) => RuntimeImageGenerationProvider[];
  };
  videoGeneration: {
    generate: (params: GenerateVideoParams) => Promise<GenerateVideoRuntimeResult>;
    listProviders: (params?: ListRuntimeVideoGenerationProvidersParams) => RuntimeVideoGenerationProvider[];
  };
  musicGeneration: {
    generate: (params: GenerateMusicParams) => Promise<GenerateMusicRuntimeResult>;
    listProviders: (params?: ListRuntimeMusicGenerationProvidersParams) => RuntimeMusicGenerationProvider[];
  };
  webSearch: {
    listProviders: (params?: ListWebSearchProvidersParams) => RuntimeWebSearchProviderEntry[];
    search: (params: RunWebSearchParams) => Promise<RunWebSearchResult>;
  };
  stt: {
    transcribeAudioFile: MediaUnderstandingRuntime["transcribeAudioFile"];
  };
  events: {
    onAgentEvent: typeof onAgentEvent;
    onSessionTranscriptUpdate: typeof onSessionTranscriptUpdate;
  };
  logging: {
    shouldLogVerbose: typeof shouldLogVerbose;
    getChildLogger: (bindings?: Record<string, unknown>, opts?: {
      level?: LogLevel;
    }) => RuntimeLogger;
  };
  state: {
    resolveStateDir: typeof resolveStateDir;
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
  };
  tasks: {
    runs: PluginRuntimeTaskRuns;
    flows: PluginRuntimeTaskFlows;
    managedFlows: PluginRuntimeTaskFlow; /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
    flow: PluginRuntimeTaskFlow;
  }; /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
  taskFlow: PluginRuntimeTaskFlow;
  llm: {
    complete: (params: LlmCompleteParams) => Promise<LlmCompleteResult>;
  };
  modelAuth: {
    /** Resolve auth for a model. Only provider/model, optional cfg, and workspaceDir are used. */getApiKeyForModel: (params: {
      model: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
      cfg?: OpenClawConfig;
      workspaceDir?: string;
    }) => Promise<ResolvedProviderAuth>; /** Resolve request-ready auth for a model, including provider runtime exchanges. */
    getRuntimeAuthForModel: (params: {
      model: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
      cfg?: OpenClawConfig;
      workspaceDir?: string;
    }) => Promise<ResolvedProviderRuntimeAuth>; /** Resolve auth for a provider by name. Only provider, optional cfg, and workspaceDir are used. */
    resolveApiKeyForProvider: (params: {
      provider: string;
      cfg?: OpenClawConfig;
      workspaceDir?: string;
    }) => Promise<ResolvedProviderAuth>;
  };
};
//#endregion
export { RecordSessionMetaFromInbound as $, emitSessionTranscriptUpdate as A, WebSearchCredentialResolutionSource as B, resolveAwsSdkEnvVarName as C, OpenClawPluginToolContext as D, OpenClawPluginHookOptions as E, WebFetchProviderContext as F, WebSearchProviderToolDefinition as G, WebSearchProviderId as H, WebFetchProviderId as I, GenerateVideoParams as J, WebSearchProviderToolExecutionContext as K, WebFetchProviderPlugin as L, PluginWebFetchProviderEntry as M, PluginWebSearchProviderEntry as N, OpenClawPluginToolFactory as O, WebFetchCredentialResolutionSource as P, ReadSessionUpdatedAt as Q, WebFetchProviderToolDefinition as R, requireApiKey as S, OpenClawPluginActiveModelContext as T, WebSearchProviderPlugin as U, WebSearchProviderContext as V, WebSearchProviderSetupContext as W, GenerateImageParams as X, GenerateVideoRuntimeResult as Y, GenerateImageRuntimeResult as Z, TaskRunDetail as _, LlmCompleteUsage as a, ResolvedProviderAuth as b, BoundTaskFlowsRuntime as c, PluginRuntimeTaskRuns as d, UpdateLastRoute as et, PluginRuntimeTasks as f, TaskRunCancelResult as g, TaskRunAggregateSummary as h, LlmCompleteResult as i, onSessionTranscriptUpdate as j, OpenClawPluginToolOptions as k, BoundTaskRunsRuntime as l, TaskFlowView as m, LlmCompleteMessage as n, PluginRuntimeCore as o, TaskFlowDetail as p, WebSearchRuntimeMetadataContext as q, LlmCompleteParams as r, RuntimeLogger as s, LlmCompleteCaller as t, resolveAgentTimeoutMs as tt, PluginRuntimeTaskFlows as u, TaskRunView as v, PluginRuntimeTaskFlow as w, formatMissingAuthError as x, ResolvedProviderRuntimeAuth as y, WebFetchRuntimeMetadataContext as z };