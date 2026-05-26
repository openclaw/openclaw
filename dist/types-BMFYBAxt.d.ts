import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { c as ExecApprovalRequestPayload$1, o as ExecApprovalDecision } from "./exec-approvals-DZ3KhICc.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-LYni1Yjz.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
import { i as WizardPrompter } from "./prompts-DgKIGa-v.js";
import { t as SecretInputMode } from "./provider-auth-types-C72FsWut.js";
import { n as AgentEventPayload } from "./agent-events-DtKTaaH3.js";
import { r as ChannelAccountSnapshot } from "./types.core-BkmTlRzr.js";
import { s as PluginApprovalRequestPayload } from "./plugin-approvals-BKi4KQTi.js";
import { Go as OperatorScope } from "./index-CaLNQFzV.js";
import { Ut as RequestFrame, W as ConnectParams, ut as ErrorShape } from "./types-DOsLYgS6.js";
import { t as CliDeps } from "./deps.types-C8BV1CgG.js";
import { t as HeartbeatSummary } from "./heartbeat-summary-Cv0tS6mF.js";
import { n as CronJobCreate, r as CronJobPatch, t as CronJob } from "./types-De71P7JW.js";
import { n as createSubsystemLogger } from "./subsystem-Ce5qcC5n.js";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { WebSocket as WebSocket$1 } from "ws";

//#region src/commands/daemon-runtime.d.ts
type GatewayDaemonRuntime = "node" | "bun";
//#endregion
//#region src/commands/onboard-types.d.ts
type OnboardMode = "local" | "remote";
/**
 * Auth choices are plugin-owned contract ids plus a few legacy aliases that
 * are normalized elsewhere (for example `oauth` -> `setup-token`).
 */
type BuiltInAuthChoice = /** @deprecated Use `setup-token`. */"oauth" | "setup-token" | "token" | "apiKey" | "custom-api-key" | "skip";
type AuthChoice = BuiltInAuthChoice | (string & {});
type GatewayAuthChoice = "token" | "password";
type ResetScope = "config" | "config+creds+sessions" | "full";
type GatewayBind = "loopback" | "lan" | "auto" | "custom" | "tailnet";
type TailscaleMode = "off" | "serve" | "funnel";
type NodeManagerChoice = "npm" | "pnpm" | "bun";
type OnboardDynamicProviderOptions = {
  /**
   * Provider-specific non-interactive auth flags are plugin-owned and keyed by
   * manifest `providerAuthChoices[].optionKey` values.
   */
  [optionKey: string]: unknown;
};
type OnboardOptions = OnboardDynamicProviderOptions & {
  mode?: OnboardMode; /** "manual" is an alias for "advanced". */
  flow?: "quickstart" | "advanced" | "manual" | "import";
  workspace?: string;
  nonInteractive?: boolean; /** Required for non-interactive setup; skips the interactive risk prompt when true. */
  acceptRisk?: boolean;
  reset?: boolean;
  resetScope?: ResetScope;
  authChoice?: AuthChoice; /** Used when `authChoice=token` in non-interactive mode. */
  tokenProvider?: string; /** Used when `authChoice=token` in non-interactive mode. */
  token?: string; /** Used when `authChoice=token` in non-interactive mode. */
  tokenProfileId?: string; /** Used when `authChoice=token` in non-interactive mode. */
  tokenExpiresIn?: string; /** API key persistence mode for setup flows (default: plaintext). */
  secretInputMode?: SecretInputMode;
  arceeaiApiKey?: string;
  cloudflareAiGatewayAccountId?: string;
  cloudflareAiGatewayGatewayId?: string;
  customBaseUrl?: string;
  customApiKey?: string;
  lmstudioApiKey?: string;
  customModelId?: string;
  customProviderId?: string;
  customCompatibility?: "openai" | "anthropic";
  customImageInput?: boolean;
  gatewayPort?: number;
  gatewayBind?: GatewayBind;
  gatewayAuth?: GatewayAuthChoice;
  gatewayToken?: string;
  gatewayTokenRefEnv?: string;
  gatewayPassword?: string;
  tailscale?: TailscaleMode;
  tailscaleResetOnExit?: boolean;
  installDaemon?: boolean;
  daemonRuntime?: GatewayDaemonRuntime;
  skipChannels?: boolean; /** @deprecated Legacy alias for `skipChannels`. */
  skipProviders?: boolean;
  skipSkills?: boolean;
  skipBootstrap?: boolean;
  skipSearch?: boolean;
  skipHealth?: boolean;
  skipUi?: boolean;
  suppressGatewayTokenOutput?: boolean;
  skipHooks?: boolean;
  nodeManager?: NodeManagerChoice;
  remoteUrl?: string;
  remoteToken?: string;
  importFrom?: string;
  importSource?: string;
  importSecrets?: boolean;
  json?: boolean;
};
//#endregion
//#region src/infra/voicewake-routing.d.ts
type VoiceWakeRouteTarget = {
  mode: "current";
  agentId?: undefined;
  sessionKey?: undefined;
} | {
  agentId: string;
  sessionKey?: undefined;
  mode?: undefined;
} | {
  sessionKey: string;
  agentId?: undefined;
  mode?: undefined;
};
type VoiceWakeRouteRule = {
  trigger: string;
  target: VoiceWakeRouteTarget;
};
type VoiceWakeRoutingConfig = {
  version: 1;
  defaultTarget: VoiceWakeRouteTarget;
  routes: VoiceWakeRouteRule[];
  updatedAtMs: number;
};
//#endregion
//#region src/gateway/model-pricing-cache-state.d.ts
type GatewayModelPricingHealthSource = "openrouter" | "litellm" | "bootstrap" | "refresh";
type GatewayModelPricingHealth = {
  state: "ok" | "degraded" | "disabled";
  sources: Array<{
    source: GatewayModelPricingHealthSource;
    state: "ok" | "degraded";
    lastFailureAt?: number;
    detail?: string;
  }>;
  lastFailureAt?: number;
  detail?: string;
};
//#endregion
//#region src/gateway/server/event-loop-health.d.ts
type GatewayEventLoopHealthReason = "event_loop_delay" | "event_loop_utilization" | "cpu";
type GatewayEventLoopHealth = {
  degraded: boolean;
  reasons: GatewayEventLoopHealthReason[];
  intervalMs: number;
  delayP99Ms: number;
  delayMaxMs: number;
  utilization: number;
  cpuCoreRatio: number;
};
//#endregion
//#region src/commands/health.types.d.ts
type ChannelAccountHealthSummary = {
  accountId: string;
  configured?: boolean;
  linked?: boolean;
  authAgeMs?: number | null;
  probe?: unknown;
  lastProbeAt?: number | null;
  [key: string]: unknown;
};
type ChannelHealthSummary = ChannelAccountHealthSummary & {
  accounts?: Record<string, ChannelAccountHealthSummary>;
};
type AgentHealthSummary = {
  agentId: string;
  name?: string;
  isDefault: boolean;
  heartbeat: HeartbeatSummary;
  sessions: HealthSummary["sessions"];
};
type PluginHealthErrorSummary = {
  id: string;
  origin: string;
  activated: boolean;
  activationSource?: string;
  activationReason?: string;
  failurePhase?: string;
  error: string;
};
type PluginHealthSummary = {
  loaded: string[];
  errors: PluginHealthErrorSummary[];
};
type ModelPricingHealthSummary = GatewayModelPricingHealth;
type HealthSummary = {
  ok: true;
  ts: number;
  durationMs: number;
  eventLoop?: GatewayEventLoopHealth;
  plugins?: PluginHealthSummary;
  modelPricing?: ModelPricingHealthSummary;
  channels: Record<string, ChannelHealthSummary>;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  heartbeatSeconds: number;
  defaultAgentId: string;
  agents: AgentHealthSummary[];
  sessions: {
    path: string;
    count: number;
    recent: Array<{
      key: string;
      updatedAt: number | null;
      age: number | null;
    }>;
  };
};
//#endregion
//#region src/cron/service/list-page-types.d.ts
type CronJobsEnabledFilter = "all" | "enabled" | "disabled";
type CronJobsSortBy = "nextRunAtMs" | "updatedAtMs" | "name";
type CronSortDir = "asc" | "desc";
type CronListPageOptions = {
  includeDisabled?: boolean;
  limit?: number;
  offset?: number;
  query?: string;
  enabled?: CronJobsEnabledFilter;
  sortBy?: CronJobsSortBy;
  sortDir?: CronSortDir;
  agentId?: string;
};
type CronListPageResult<TJobs extends readonly CronJob[] = CronJob[]> = {
  jobs: TJobs;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};
//#endregion
//#region src/cron/service/state.d.ts
type CronRunMode = "due" | "force";
type CronWakeMode = "now" | "next-heartbeat";
type CronStatusSummary = {
  enabled: boolean;
  storePath: string;
  jobs: number;
  nextWakeAtMs: number | null;
};
type CronRunResult = {
  ok: true;
  ran: true;
} | {
  ok: true;
  enqueued: true;
  runId: string;
} | {
  ok: true;
  ran: false;
  reason: "not-due";
} | {
  ok: true;
  ran: false;
  reason: "already-running";
} | {
  ok: false;
};
type CronRemoveResult = {
  ok: true;
  removed: boolean;
} | {
  ok: false;
  removed: false;
};
type CronAddResult = CronJob;
type CronUpdateResult = CronJob;
type CronListResult = CronJob[];
type CronAddInput = CronJobCreate;
type CronUpdateInput = CronJobPatch;
//#endregion
//#region src/cron/service-contract.d.ts
type CronWakeResult = {
  ok: true;
} | {
  ok: false;
  reason?: "unwakeable-session-key";
};
type CronServiceRunResult = CronRunResult | {
  ok: true;
  ran: false;
  reason: "invalid-spec";
};
interface CronServiceContract {
  start(): Promise<void>;
  stop(): void;
  status(): Promise<CronStatusSummary>;
  list(opts?: {
    includeDisabled?: boolean;
  }): Promise<CronListResult>;
  listPage(opts?: CronListPageOptions): Promise<CronListPageResult>;
  add(input: CronAddInput): Promise<CronAddResult>;
  update(id: string, patch: CronUpdateInput): Promise<CronUpdateResult>;
  remove(id: string): Promise<CronRemoveResult>;
  run(id: string, mode?: CronRunMode): Promise<CronServiceRunResult>;
  enqueueRun(id: string, mode?: CronRunMode): Promise<CronServiceRunResult>;
  getJob(id: string): CronJob | undefined;
  readJob(id: string): Promise<CronJob | undefined>;
  getDefaultAgentId(): string | undefined;
  wake(opts: {
    mode: CronWakeMode;
    text: string;
    sessionKey?: string;
  }): CronWakeResult;
}
//#endregion
//#region src/wizard/session.d.ts
type WizardStepOption = {
  value: unknown;
  label: string;
  hint?: string;
};
type WizardStep = {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
  title?: string;
  message?: string;
  format?: "plain";
  options?: WizardStepOption[];
  initialValue?: unknown;
  placeholder?: string;
  sensitive?: boolean;
  executor?: "gateway" | "client";
};
type WizardSessionStatus = "running" | "done" | "cancelled" | "error";
type WizardNextResult = {
  done: boolean;
  step?: WizardStep;
  status: WizardSessionStatus;
  error?: string;
};
declare class WizardSession {
  private runner;
  private currentStep;
  private stepDeferred;
  private pendingTerminalResolution;
  private answerDeferred;
  private status;
  private error;
  constructor(runner: (prompter: WizardPrompter) => Promise<void>);
  next(): Promise<WizardNextResult>;
  answer(stepId: string, value: unknown): Promise<void>;
  cancel(): void;
  pushStep(step: WizardStep): void;
  private run;
  awaitAnswer(step: WizardStep): Promise<unknown>;
  private resolveStep;
  getStatus(): WizardSessionStatus;
  getError(): string | undefined;
}
//#endregion
//#region src/gateway/server-chat-state.d.ts
type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};
type BufferedAgentEvent = {
  sessionKey?: string;
  payload: AgentEventPayload & {
    spawnedBy?: string;
  };
};
type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};
type ChatRunState = {
  registry: ChatRunRegistry;
  rawBuffers: Map<string, string>;
  buffers: Map<string, string>;
  deltaSentAt: Map<string, number>; /** Length of text at the time of the last broadcast, used to avoid duplicate flushes. */
  deltaLastBroadcastLen: Map<string, number>;
  deltaLastBroadcastText: Map<string, string>;
  agentDeltaSentAt: Map<string, number>;
  bufferedAgentEvents: Map<string, BufferedAgentEvent>;
  abortedRuns: Map<string, number>;
  clear: () => void;
};
//#endregion
//#region src/gateway/chat-abort.d.ts
type ChatAbortControllerEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  startedAtMs: number;
  expiresAtMs: number;
  ownerConnId?: string;
  ownerDeviceId?: string;
  providerId?: string;
  authProviderId?: string;
  abortStopReason?: string;
  /**
   * Which RPC owns this registration. Absent (undefined) is treated as
   * `"chat-send"` so pre-existing callers that constructed entries without
   * a kind keep their behavior. Consumers that need "chat.send specifically
   * is active" must check `kind !== "agent"`, not just `.has(runId)`.
   */
  kind?: "chat-send" | "agent";
};
//#endregion
//#region src/gateway/exec-approval-manager.d.ts
type ExecApprovalRequestPayload = ExecApprovalRequestPayload$1;
type ExecApprovalRecord<TPayload = ExecApprovalRequestPayload> = {
  id: string;
  request: TPayload;
  createdAtMs: number;
  expiresAtMs: number;
  requestedByConnId?: string | null;
  requestedByDeviceId?: string | null;
  requestedByClientId?: string | null;
  requestedByDeviceTokenAuth?: boolean;
  resolvedAtMs?: number;
  decision?: ExecApprovalDecision;
  consumedDecision?: ExecApprovalDecision;
  resolvedBy?: string | null;
};
type ExecApprovalIdLookupResult = {
  kind: "exact" | "prefix";
  id: string;
} | {
  kind: "ambiguous";
  ids: string[];
} | {
  kind: "none";
};
declare class ExecApprovalManager<TPayload = ExecApprovalRequestPayload> {
  private pending;
  create(request: TPayload, timeoutMs: number, id?: string | null): ExecApprovalRecord<TPayload>;
  /**
   * Register an approval record and return a promise that resolves when the decision is made.
   * This separates registration (synchronous) from waiting (async), allowing callers to
   * confirm registration before the decision is made.
   */
  register(record: ExecApprovalRecord<TPayload>, timeoutMs: number): Promise<ExecApprovalDecision | null>;
  /**
   * @deprecated Use register() instead for explicit separation of registration and waiting.
   */
  waitForDecision(record: ExecApprovalRecord<TPayload>, timeoutMs: number): Promise<ExecApprovalDecision | null>;
  resolve(recordId: string, decision: ExecApprovalDecision, resolvedBy?: string | null): boolean;
  expire(recordId: string, resolvedBy?: string | null): boolean;
  getSnapshot(recordId: string): ExecApprovalRecord<TPayload> | null;
  listPendingRecords(): ExecApprovalRecord<TPayload>[];
  consumeAllowOnce(recordId: string): boolean;
  /**
   * Wait for decision on an already-registered approval.
   * Returns the decision promise if the ID is pending, null otherwise.
   */
  awaitDecision(recordId: string): Promise<ExecApprovalDecision | null> | null;
  lookupApprovalId(input: string, opts?: {
    includeResolved?: boolean;
    filter?: (record: ExecApprovalRecord<TPayload>) => boolean;
  }): ExecApprovalIdLookupResult;
  lookupPendingId(input: string): ExecApprovalIdLookupResult;
}
//#endregion
//#region src/gateway/methods/descriptor.d.ts
declare const NODE_GATEWAY_METHOD_SCOPE: "node";
declare const DYNAMIC_GATEWAY_METHOD_SCOPE: "dynamic";
type GatewayMethodScope = OperatorScope | typeof NODE_GATEWAY_METHOD_SCOPE | typeof DYNAMIC_GATEWAY_METHOD_SCOPE;
type GatewayMethodOwner = {
  kind: "core";
  area: string;
} | {
  kind: "plugin";
  pluginId: string;
} | {
  kind: "channel";
  channelId: string;
} | {
  kind: "aux";
  area: string;
};
type GatewayMethodStartupAvailability = "available" | "unavailable-until-sidecars";
type GatewayMethodHandler = (opts: never) => unknown;
type GatewayMethodDescriptor = {
  name: string;
  handler: GatewayMethodHandler;
  scope: GatewayMethodScope;
  owner: GatewayMethodOwner;
  startup?: GatewayMethodStartupAvailability;
  controlPlaneWrite?: boolean;
  advertise?: boolean;
  description?: string;
};
type GatewayMethodRegistryView = {
  getHandler: (name: string) => GatewayMethodHandler | undefined;
  listMethods: () => string[];
  listAdvertisedMethods: () => string[];
  getScope: (name: string) => GatewayMethodScope | undefined;
  isStartupUnavailable: (name: string) => boolean;
  isControlPlaneWrite: (name: string) => boolean;
  descriptors: () => readonly GatewayMethodDescriptor[];
};
//#endregion
//#region src/gateway/plugin-node-capability.d.ts
declare const PLUGIN_NODE_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
declare const DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS: number;
type PluginNodeCapabilitySurface = {
  surface: string;
  ttlMs?: number;
  scopeKey?: string;
};
type PluginNodeCapabilityClient = {
  pluginSurfaceUrls?: Record<string, string>;
  pluginNodeCapabilitySurfaces?: Record<string, PluginNodeCapabilitySurface>;
  pluginNodeCapabilities?: Record<string, {
    capability: string;
    expiresAtMs: number;
  }>;
};
type NormalizedPluginNodeCapabilityUrl = {
  pathname: string;
  capability?: string;
  rewrittenUrl?: string;
  scopedPath: boolean;
  malformedScopedPath: boolean;
};
declare function mintPluginNodeCapabilityToken(): string;
declare function buildPluginNodeCapabilityScopedHostUrl(baseUrl: string, capability: string): string | undefined;
declare function normalizePluginNodeCapabilityScopedUrl(rawUrl: string): NormalizedPluginNodeCapabilityUrl;
//#endregion
//#region src/gateway/server/ws-types.d.ts
type GatewayWsClient = PluginNodeCapabilityClient & {
  socket: WebSocket$1;
  connect: ConnectParams;
  connId: string;
  isDeviceTokenAuth?: boolean;
  usesSharedGatewayAuth: boolean;
  sharedGatewaySessionGeneration?: string;
  presenceKey?: string;
  clientIp?: string;
  internal?: {
    approvalRuntime?: boolean;
  };
};
//#endregion
//#region src/gateway/node-registry.d.ts
type NodeSession = {
  nodeId: string;
  connId: string;
  client: GatewayWsClient;
  clientId?: string;
  clientMode?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  declaredCaps: string[];
  caps: string[];
  declaredCommands: string[];
  commands: string[];
  declaredPermissions?: Record<string, boolean>;
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
};
type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: {
    code?: string;
    message?: string;
  } | null;
};
type NodeConnectivityResult = {
  ok: true;
} | {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};
declare const SERIALIZED_EVENT_PAYLOAD: unique symbol;
type SerializedEventPayload = {
  readonly json: string;
  readonly [SERIALIZED_EVENT_PAYLOAD]: true;
};
declare class NodeRegistry {
  private nodesById;
  private nodesByConn;
  private pendingInvokes;
  private authorizedSystemRunEvents;
  register(client: GatewayWsClient, opts: {
    remoteIp?: string | undefined;
  }): NodeSession;
  unregister(connId: string): string | null;
  listConnected(): NodeSession[];
  get(nodeId: string): NodeSession | undefined;
  checkConnectivity(nodeId: string, timeoutMs?: number): Promise<NodeConnectivityResult>;
  updateCommands(nodeId: string, commands: readonly string[]): NodeSession | null;
  updateSurface(nodeId: string, surface: {
    caps?: readonly string[];
    commands: readonly string[];
    permissions?: Record<string, boolean> | undefined;
  }): NodeSession | null;
  invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<NodeInvokeResult>;
  authorizeSystemRunEvent(params: {
    nodeId: string;
    connId?: string;
    runId?: string;
    sessionKey: string;
    terminal: boolean;
  }): boolean;
  private rememberAuthorizedSystemRunEvent;
  private forgetAuthorizedSystemRunEvent;
  private authorizedSystemRunEventExpiresAt;
  private matchAuthorizedSystemRunEvent;
  private matchSingleAuthorizedSystemRunEvent;
  private authorizedSystemRunSessionMatches;
  private allowsLegacyMacRunIdFallback;
  private pruneAuthorizedSystemRunEvents;
  private authorizedSystemRunEventKey;
  handleInvokeResult(params: {
    id: string;
    nodeId: string;
    connId: string | undefined;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: {
      code?: string;
      message?: string;
    } | null;
  }): boolean;
  sendEvent(nodeId: string, event: string, payload?: unknown): boolean;
  sendEventRaw(nodeId: string, event: string, payloadJSON?: SerializedEventPayload | null): boolean;
  private sendEventInternal;
  private sendEventRawInternal;
  private sendEventToSession;
  private rejectSlowNodeSocket;
}
//#endregion
//#region src/gateway/server-broadcast-types.d.ts
type GatewayBroadcastStateVersion = {
  presence?: number;
  health?: number;
};
type GatewayBroadcastOpts = {
  dropIfSlow?: boolean;
  stateVersion?: GatewayBroadcastStateVersion;
};
type GatewayBroadcastFn = (event: string, payload: unknown, opts?: GatewayBroadcastOpts) => void;
type GatewayBroadcastToConnIdsFn = (event: string, payload: unknown, connIds: ReadonlySet<string>, opts?: GatewayBroadcastOpts) => void;
//#endregion
//#region src/gateway/server-channel-runtime.types.d.ts
type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};
//#endregion
//#region src/gateway/server-shared.d.ts
type DedupeEntry = {
  ts: number;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};
//#endregion
//#region src/gateway/server-methods/shared-types.d.ts
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;
type GatewayClient = {
  connect: ConnectParams;
  connId?: string;
  clientIp?: string;
  pluginSurfaceUrls?: Record<string, string>;
  pluginNodeCapabilitySurfaces?: Record<string, PluginNodeCapabilitySurface>;
  pluginNodeCapabilities?: Record<string, {
    capability: string;
    expiresAtMs: number;
  }>;
  isDeviceTokenAuth?: boolean;
  internal?: {
    allowModelOverride?: boolean;
    approvalRuntime?: boolean;
    pluginRuntimeOwnerId?: string;
  };
};
type RespondFn = (ok: boolean, payload?: unknown, error?: ErrorShape, meta?: Record<string, unknown>) => void;
type GatewayRequestContext = {
  deps: CliDeps;
  cron: CronServiceContract;
  cronStorePath: string;
  getRuntimeConfig: () => OpenClawConfig;
  execApprovalManager?: ExecApprovalManager;
  pluginApprovalManager?: ExecApprovalManager<PluginApprovalRequestPayload>;
  loadGatewayModelCatalog: (params?: {
    readOnly?: boolean;
  }) => Promise<ModelCatalogEntry[]>;
  getHealthCache: () => HealthSummary | null;
  refreshHealthSnapshot: (opts?: {
    probe?: boolean;
    includeSensitive?: boolean;
  }) => Promise<HealthSummary>;
  logHealth: {
    error: (message: string) => void;
  };
  logGateway: SubsystemLogger;
  incrementPresenceVersion: () => number;
  getHealthVersion: () => number;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  nodeSubscribe: (nodeId: string, sessionKey: string) => void;
  nodeUnsubscribe: (nodeId: string, sessionKey: string) => void;
  nodeUnsubscribeAll: (nodeId: string) => void;
  hasConnectedTalkNode: () => boolean;
  hasExecApprovalClients?: (excludeConnId?: string) => boolean;
  getApprovalClientConnIds?: <TPayload>(params?: {
    excludeConnId?: string;
    filter?: (client: GatewayClient, record?: ExecApprovalRecord<TPayload>) => boolean;
    record?: ExecApprovalRecord<TPayload>;
  }) => ReadonlySet<string>;
  disconnectClientsForDevice?: (deviceId: string, opts?: {
    role?: string;
  }) => void;
  disconnectClientsUsingSharedGatewayAuth?: () => void;
  enforceSharedGatewayAuthGenerationForConfigWrite?: (nextConfig: OpenClawConfig) => void;
  nodeRegistry: NodeRegistry;
  agentRunSeq: Map<string, number>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatAbortedRuns: Map<string, number>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  chatDeltaLastBroadcastText: Map<string, string>;
  agentDeltaSentAt: Map<string, number>;
  bufferedAgentEvents: Map<string, BufferedAgentEvent>;
  addChatRun: (sessionId: string, entry: {
    sessionKey: string;
    clientRunId: string;
  }) => void;
  removeChatRun: (sessionId: string, clientRunId: string, sessionKey?: string) => {
    sessionKey: string;
    clientRunId: string;
  } | undefined;
  subscribeSessionEvents: (connId: string) => void;
  unsubscribeSessionEvents: (connId: string) => void;
  subscribeSessionMessageEvents: (connId: string, sessionKey: string) => void;
  unsubscribeSessionMessageEvents: (connId: string, sessionKey: string) => void;
  unsubscribeAllSessionEvents: (connId: string) => void;
  getSessionEventSubscriberConnIds: () => ReadonlySet<string>;
  registerToolEventRecipient: (runId: string, connId: string) => void;
  dedupe: Map<string, DedupeEntry>;
  wizardSessions: Map<string, WizardSession>;
  findRunningWizard: () => string | null;
  purgeWizardSession: (id: string) => void;
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
  startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  stopChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  wizardRunner: (opts: OnboardOptions, runtime: RuntimeEnv, prompter: WizardPrompter) => Promise<void>;
  broadcastVoiceWakeChanged: (triggers: string[]) => void;
  broadcastVoiceWakeRoutingChanged: (config: VoiceWakeRoutingConfig) => void;
  unavailableGatewayMethods?: ReadonlySet<string>;
};
type GatewayRequestOptions = {
  req: RequestFrame;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
  methodRegistry?: GatewayMethodRegistryView;
};
type GatewayRequestHandlerOptions = {
  req: RequestFrame;
  params: Record<string, unknown>;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
};
type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
type GatewayRequestHandlers = Record<string, GatewayRequestHandler>;
//#endregion
export { ChatRunState as _, GatewayRequestOptions as a, DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS as c, PluginNodeCapabilitySurface as d, buildPluginNodeCapabilityScopedHostUrl as f, ChatAbortControllerEntry as g, GatewayMethodDescriptor as h, GatewayRequestHandlers as i, NormalizedPluginNodeCapabilityUrl as l, normalizePluginNodeCapabilityScopedUrl as m, GatewayRequestHandler as n, RespondFn as o, mintPluginNodeCapabilityToken as p, GatewayRequestHandlerOptions as r, NodeSession as s, GatewayRequestContext as t, PLUGIN_NODE_CAPABILITY_PATH_PREFIX as u, CronServiceContract as v };