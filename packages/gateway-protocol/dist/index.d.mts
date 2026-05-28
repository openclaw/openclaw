import { n as MIN_PROBE_PROTOCOL_VERSION, r as PROTOCOL_VERSION, t as MIN_CLIENT_PROTOCOL_VERSION } from "./version-CkdglHN3.mjs";
import { AgentEvent, AgentEventSchema, AgentIdentityParams, AgentIdentityParamsSchema, AgentIdentityResult, AgentIdentityResultSchema, AgentParamsSchema, AgentSummary, AgentSummarySchema, AgentWaitParams, AgentsCreateParams, AgentsCreateParamsSchema, AgentsCreateResult, AgentsCreateResultSchema, AgentsDeleteParams, AgentsDeleteParamsSchema, AgentsDeleteResult, AgentsDeleteResultSchema, AgentsFileEntry, AgentsFileEntrySchema, AgentsFilesGetParams, AgentsFilesGetParamsSchema, AgentsFilesGetResult, AgentsFilesGetResultSchema, AgentsFilesListParams, AgentsFilesListParamsSchema, AgentsFilesListResult, AgentsFilesListResultSchema, AgentsFilesSetParams, AgentsFilesSetParamsSchema, AgentsFilesSetResult, AgentsFilesSetResultSchema, AgentsListParams, AgentsListParamsSchema, AgentsListResult, AgentsListResultSchema, AgentsUpdateParams, AgentsUpdateParamsSchema, AgentsUpdateResult, AgentsUpdateResultSchema, ArtifactSummary, ArtifactSummarySchema, ArtifactsDownloadParams, ArtifactsDownloadParamsSchema, ArtifactsDownloadResult, ArtifactsGetParams, ArtifactsGetParamsSchema, ArtifactsGetResult, ArtifactsListParams, ArtifactsListParamsSchema, ArtifactsListResult, ChannelsLogoutParams, ChannelsLogoutParamsSchema, ChannelsStartParams, ChannelsStartParamsSchema, ChannelsStatusParams, ChannelsStatusParamsSchema, ChannelsStatusResult, ChannelsStatusResultSchema, ChannelsStopParams, ChannelsStopParamsSchema, ChatEvent, ChatEventSchema, ChatHistoryParamsSchema, ChatInjectParams, ChatInjectParamsSchema, ChatSendParamsSchema, CommandEntry, CommandsListParams, CommandsListParamsSchema, CommandsListResult, CommandsListResultSchema, ConfigApplyParams, ConfigApplyParamsSchema, ConfigGetParams, ConfigGetParamsSchema, ConfigPatchParams, ConfigPatchParamsSchema, ConfigSchemaLookupParamsSchema, ConfigSchemaLookupResultSchema, ConfigSchemaParams, ConfigSchemaParamsSchema, ConfigSchemaResponse, ConfigSchemaResponseSchema, ConfigSetParams, ConfigSetParamsSchema, ConnectParams, ConnectParamsSchema, CronAddParams, CronAddParamsSchema, CronGetParams, CronGetParamsSchema, CronJob, CronJobSchema, CronListParams, CronListParamsSchema, CronRemoveParams, CronRemoveParamsSchema, CronRunLogEntry, CronRunParams, CronRunParamsSchema, CronRunsParams, CronRunsParamsSchema, CronStatusParams, CronStatusParamsSchema, CronUpdateParams, CronUpdateParamsSchema, DevicePairApproveParams, DevicePairListParams, DevicePairRejectParams, EnvironmentStatus, EnvironmentStatusSchema, EnvironmentSummary, EnvironmentSummarySchema, EnvironmentsListParams, EnvironmentsListParamsSchema, EnvironmentsListResult, EnvironmentsListResultSchema, EnvironmentsStatusParams, EnvironmentsStatusParamsSchema, EnvironmentsStatusResult, EnvironmentsStatusResultSchema, ErrorCodes, ErrorShape, ErrorShapeSchema, EventFrame, EventFrameSchema, ExecApprovalGetParams, ExecApprovalGetParamsSchema, ExecApprovalRequestParams, ExecApprovalRequestParamsSchema, ExecApprovalResolveParams, ExecApprovalResolveParamsSchema, ExecApprovalsGetParams, ExecApprovalsGetParamsSchema, ExecApprovalsSetParams, ExecApprovalsSetParamsSchema, ExecApprovalsSnapshot, GatewayFrame, GatewayFrameSchema, HelloOk, HelloOkSchema, LogsTailParams, LogsTailParamsSchema, LogsTailResult, LogsTailResultSchema, MessageActionParamsSchema, ModelsListParamsSchema, NodeEventParams, NodeEventResult, NodeEventResultSchema, NodeInvokeParams, NodeInvokeParamsSchema, NodeInvokeResultParams, NodeListParams, NodeListParamsSchema, NodePairApproveParams, NodePairApproveParamsSchema, NodePairListParams, NodePairListParamsSchema, NodePairRejectParams, NodePairRejectParamsSchema, NodePairRemoveParams, NodePairRemoveParamsSchema, NodePairRequestParams, NodePairRequestParamsSchema, NodePairVerifyParams, NodePairVerifyParamsSchema, NodePendingAckParamsSchema, NodePendingDrainParams, NodePendingDrainParamsSchema, NodePendingDrainResult, NodePendingDrainResultSchema, NodePendingEnqueueParams, NodePendingEnqueueParamsSchema, NodePendingEnqueueResult, NodePendingEnqueueResultSchema, NodePresenceAlivePayload, NodePresenceAlivePayloadSchema, NodePresenceAliveReason, NodePresenceAliveReasonSchema, PluginsSessionActionParams, PluginsSessionActionParamsSchema, PluginsSessionActionResult, PluginsSessionActionResultSchema, PluginsUiDescriptorsParamsSchema, PollParams, PollParamsSchema, PresenceEntry, PresenceEntrySchema, ProtocolSchemas, PushTestParamsSchema, PushTestResultSchema, RequestFrame, RequestFrameSchema, ResponseFrame, ResponseFrameSchema, SendParamsSchema, SessionOperationEvent, SessionsAbortParamsSchema, SessionsCleanupParams, SessionsCleanupParamsSchema, SessionsCompactParams, SessionsCompactParamsSchema, SessionsCompactionBranchParamsSchema, SessionsCompactionGetParamsSchema, SessionsCompactionListParamsSchema, SessionsCompactionRestoreParamsSchema, SessionsCreateParamsSchema, SessionsDeleteParams, SessionsDeleteParamsSchema, SessionsDescribeParams, SessionsDescribeParamsSchema, SessionsListParams, SessionsListParamsSchema, SessionsPatchParams, SessionsPatchParamsSchema, SessionsPluginPatchParamsSchema, SessionsPreviewParams, SessionsPreviewParamsSchema, SessionsResetParams, SessionsResetParamsSchema, SessionsResolveParams, SessionsResolveParamsSchema, SessionsSendParamsSchema, SessionsUsageParams, SessionsUsageParamsSchema, ShutdownEvent, ShutdownEventSchema, SkillsBinsParams, SkillsBinsResult, SkillsDetailParams, SkillsDetailParamsSchema, SkillsDetailResult, SkillsDetailResultSchema, SkillsInstallParams, SkillsInstallParamsSchema, SkillsSearchParams, SkillsSearchParamsSchema, SkillsSearchResult, SkillsSearchResultSchema, SkillsSecurityVerdictsParams, SkillsSecurityVerdictsParamsSchema, SkillsSecurityVerdictsResult, SkillsSecurityVerdictsResultSchema, SkillsSkillCardParams, SkillsSkillCardParamsSchema, SkillsSkillCardResult, SkillsSkillCardResultSchema, SkillsStatusParams, SkillsStatusParamsSchema, SkillsUpdateParams, SkillsUpdateParamsSchema, SkillsUploadBeginParams, SkillsUploadBeginParamsSchema, SkillsUploadChunkParams, SkillsUploadChunkParamsSchema, SkillsUploadCommitParams, SkillsUploadCommitParamsSchema, Snapshot, SnapshotSchema, StateVersion, StateVersionSchema, TalkAgentControlResult, TalkAgentControlResultSchema, TalkCatalogParams, TalkCatalogParamsSchema, TalkCatalogResult, TalkCatalogResultSchema, TalkClientCreateParams, TalkClientCreateParamsSchema, TalkClientCreateResult, TalkClientCreateResultSchema, TalkClientSteerParams, TalkClientSteerParamsSchema, TalkClientToolCallParams, TalkClientToolCallParamsSchema, TalkClientToolCallResult, TalkClientToolCallResultSchema, TalkConfigParams, TalkConfigParamsSchema, TalkConfigResult, TalkConfigResultSchema, TalkEventSchema, TalkModeParams, TalkSessionAppendAudioParams, TalkSessionAppendAudioParamsSchema, TalkSessionCancelOutputParams, TalkSessionCancelOutputParamsSchema, TalkSessionCancelTurnParams, TalkSessionCancelTurnParamsSchema, TalkSessionCloseParams, TalkSessionCloseParamsSchema, TalkSessionCreateParams, TalkSessionCreateParamsSchema, TalkSessionCreateResult, TalkSessionCreateResultSchema, TalkSessionJoinParams, TalkSessionJoinParamsSchema, TalkSessionJoinResult, TalkSessionJoinResultSchema, TalkSessionOkResult, TalkSessionOkResultSchema, TalkSessionSteerParams, TalkSessionSteerParamsSchema, TalkSessionSubmitToolResultParams, TalkSessionSubmitToolResultParamsSchema, TalkSessionTurnParams, TalkSessionTurnParamsSchema, TalkSessionTurnResult, TalkSessionTurnResultSchema, TalkSpeakParams, TalkSpeakParamsSchema, TalkSpeakResult, TalkSpeakResultSchema, TaskSummary, TaskSummarySchema, TasksCancelParams, TasksCancelParamsSchema, TasksCancelResult, TasksCancelResultSchema, TasksGetParams, TasksGetParamsSchema, TasksGetResult, TasksGetResultSchema, TasksListParams, TasksListParamsSchema, TasksListResult, TasksListResultSchema, TickEvent, TickEventSchema, ToolsCatalogParams, ToolsCatalogParamsSchema, ToolsCatalogResult, ToolsEffectiveParams, ToolsEffectiveParamsSchema, ToolsEffectiveResult, ToolsInvokeParams, ToolsInvokeParamsSchema, ToolsInvokeResult, UpdateRunParams, UpdateRunParamsSchema, UpdateStatusParams, UpdateStatusParamsSchema, WakeParams, WakeParamsSchema, WebLoginStartParams, WebLoginStartParamsSchema, WebLoginWaitParams, WebLoginWaitParamsSchema, WebPushSubscribeParams, WebPushSubscribeParamsSchema, WebPushTestParams, WebPushTestParamsSchema, WebPushUnsubscribeParams, WebPushUnsubscribeParamsSchema, WebPushVapidPublicKeyParams, WebPushVapidPublicKeyParamsSchema, WizardCancelParams, WizardCancelParamsSchema, WizardNextParams, WizardNextParamsSchema, WizardNextResult, WizardNextResultSchema, WizardStartParams, WizardStartParamsSchema, WizardStartResult, WizardStartResultSchema, WizardStatusParams, WizardStatusParamsSchema, WizardStatusResult, WizardStatusResultSchema, WizardStep, WizardStepSchema, errorShape } from "./schema.mjs";

//#region packages/gateway-protocol/src/index.d.ts
type ValidationError = {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  params?: Record<string, unknown>;
  message?: string;
};
type ProtocolValidator<T = unknown> = ((data: unknown) => data is T) & {
  errors: ValidationError[] | null;
  schema: unknown;
};
declare const validateCommandsListParams: ProtocolValidator<{
  scope?: "text" | "native" | "both" | undefined;
  agentId?: string | undefined;
  provider?: string | undefined;
  includeArgs?: boolean | undefined;
}>;
declare const validateConnectParams: ProtocolValidator<{
  caps?: string[] | undefined;
  commands?: string[] | undefined;
  permissions?: Record<string, boolean> | undefined;
  pathEnv?: string | undefined;
  role?: string | undefined;
  scopes?: string[] | undefined;
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  } | undefined;
  auth?: {
    token?: string | undefined;
    bootstrapToken?: string | undefined;
    deviceToken?: string | undefined;
    password?: string | undefined;
    approvalRuntimeToken?: string | undefined;
  } | undefined;
  locale?: string | undefined;
  userAgent?: string | undefined;
  minProtocol: number;
  maxProtocol: number;
  client: {
    displayName?: string | undefined;
    deviceFamily?: string | undefined;
    modelIdentifier?: string | undefined;
    instanceId?: string | undefined;
    id: "webchat-ui" | "openclaw-control-ui" | "openclaw-tui" | "webchat" | "cli" | "gateway-client" | "openclaw-macos" | "openclaw-ios" | "openclaw-android" | "node-host" | "test" | "fingerprint" | "openclaw-probe";
    version: string;
    platform: string;
    mode: "webchat" | "cli" | "test" | "ui" | "backend" | "node" | "probe";
  };
}>;
declare const validateRequestFrame: ProtocolValidator<{
  params?: unknown;
  id: string;
  type: "req";
  method: string;
}>;
declare const validateResponseFrame: ProtocolValidator<{
  payload?: unknown;
  error?: {
    details?: unknown;
    retryable?: boolean | undefined;
    retryAfterMs?: number | undefined;
    code: string;
    message: string;
  } | undefined;
  id: string;
  type: "res";
  ok: boolean;
}>;
declare const validateEventFrame: ProtocolValidator<{
  stateVersion?: {
    presence: number;
    health: number;
  } | undefined;
  payload?: unknown;
  seq?: number | undefined;
  type: "event";
  event: string;
}>;
declare const validateMessageActionParams: ProtocolValidator<{
  accountId?: string | undefined;
  requesterSenderId?: string | undefined;
  senderIsOwner?: boolean | undefined;
  sessionKey?: string | undefined;
  sessionId?: string | undefined;
  inboundTurnKind?: string | undefined;
  agentId?: string | undefined;
  toolContext?: {
    currentChannelId?: string | undefined;
    currentGraphChannelId?: string | undefined;
    currentChannelProvider?: string | undefined;
    currentThreadTs?: string | undefined;
    currentMessageId?: string | number | undefined;
    replyToMode?: "off" | "first" | "all" | "batched" | undefined;
    hasRepliedRef?: {
      value: boolean;
    } | undefined;
    skipCrossContextDecoration?: boolean | undefined;
  } | undefined;
  channel: string;
  params: Record<string, unknown>;
  action: string;
  idempotencyKey: string;
}>;
declare const validateSendParams: ProtocolValidator<unknown>;
declare const validatePollParams: ProtocolValidator<{
  channel?: string | undefined;
  accountId?: string | undefined;
  threadId?: string | undefined;
  silent?: boolean | undefined;
  maxSelections?: number | undefined;
  durationSeconds?: number | undefined;
  durationHours?: number | undefined;
  isAnonymous?: boolean | undefined;
  idempotencyKey: string;
  to: string;
  question: string;
  options: string[];
}>;
declare const validateAgentParams: ProtocolValidator<unknown>;
declare const validateAgentIdentityParams: ProtocolValidator<{
  sessionKey?: string | undefined;
  agentId?: string | undefined;
}>;
declare const validateAgentWaitParams: ProtocolValidator<{
  timeoutMs?: number | undefined;
  runId: string;
}>;
declare const validateWakeParams: ProtocolValidator<{
  sessionKey?: string | undefined;
  mode: "now" | "next-heartbeat";
  text: string;
}>;
declare const validateAgentsListParams: ProtocolValidator<object>;
declare const validateAgentsCreateParams: ProtocolValidator<{
  model?: string | undefined;
  avatar?: string | undefined;
  emoji?: string | undefined;
  name: string;
  workspace: string;
}>;
declare const validateAgentsUpdateParams: ProtocolValidator<{
  model?: string | undefined;
  name?: string | undefined;
  avatar?: string | undefined;
  emoji?: string | undefined;
  workspace?: string | undefined;
  agentId: string;
}>;
declare const validateAgentsDeleteParams: ProtocolValidator<{
  deleteFiles?: boolean | undefined;
  agentId: string;
}>;
declare const validateAgentsFilesListParams: ProtocolValidator<{
  agentId: string;
}>;
declare const validateAgentsFilesGetParams: ProtocolValidator<{
  agentId: string;
  name: string;
}>;
declare const validateAgentsFilesSetParams: ProtocolValidator<{
  agentId: string;
  name: string;
  content: string;
}>;
declare const validateArtifactsListParams: ProtocolValidator<{
  runId?: string | undefined;
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  taskId?: string | undefined;
}>;
declare const validateArtifactsGetParams: ProtocolValidator<{
  runId?: string | undefined;
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  taskId?: string | undefined;
  artifactId: string;
}>;
declare const validateArtifactsDownloadParams: ProtocolValidator<{
  runId?: string | undefined;
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  taskId?: string | undefined;
  artifactId: string;
}>;
declare const validateNodePairRequestParams: ProtocolValidator<{
  displayName?: string | undefined;
  version?: string | undefined;
  platform?: string | undefined;
  deviceFamily?: string | undefined;
  modelIdentifier?: string | undefined;
  caps?: string[] | undefined;
  commands?: string[] | undefined;
  permissions?: Record<string, boolean> | undefined;
  silent?: boolean | undefined;
  coreVersion?: string | undefined;
  uiVersion?: string | undefined;
  remoteIp?: string | undefined;
  nodeId: string;
}>;
declare const validateNodePairListParams: ProtocolValidator<object>;
declare const validateNodePairApproveParams: ProtocolValidator<{
  requestId: string;
}>;
declare const validateNodePairRejectParams: ProtocolValidator<{
  requestId: string;
}>;
declare const validateNodePairRemoveParams: ProtocolValidator<{
  nodeId: string;
}>;
declare const validateNodePairVerifyParams: ProtocolValidator<{
  token: string;
  nodeId: string;
}>;
declare const validateNodeRenameParams: ProtocolValidator<{
  displayName: string;
  nodeId: string;
}>;
declare const validateNodeListParams: ProtocolValidator<object>;
declare const validateEnvironmentsListParams: ProtocolValidator<object>;
declare const validateEnvironmentsStatusParams: ProtocolValidator<{
  environmentId: string;
}>;
declare const validateNodePendingAckParams: ProtocolValidator<{
  ids: string[];
}>;
declare const validateNodeDescribeParams: ProtocolValidator<{
  nodeId: string;
}>;
declare const validateNodeInvokeParams: ProtocolValidator<{
  params?: unknown;
  timeoutMs?: number | undefined;
  idempotencyKey: string;
  nodeId: string;
  command: string;
}>;
declare const validateNodeInvokeResultParams: ProtocolValidator<{
  payload?: unknown;
  error?: {
    code?: string | undefined;
    message?: string | undefined;
  } | undefined;
  payloadJSON?: string | undefined;
  id: string;
  ok: boolean;
  nodeId: string;
}>;
declare const validateNodeEventParams: ProtocolValidator<{
  payload?: unknown;
  payloadJSON?: string | undefined;
  event: string;
}>;
declare const validateNodeEventResult: ProtocolValidator<{
  reason?: string | undefined;
  ok: boolean;
  event: string;
  handled: boolean;
}>;
declare const validateNodePresenceAlivePayload: ProtocolValidator<{
  displayName?: string | undefined;
  version?: string | undefined;
  platform?: string | undefined;
  deviceFamily?: string | undefined;
  modelIdentifier?: string | undefined;
  sentAtMs?: number | undefined;
  pushTransport?: string | undefined;
  trigger: string;
}>;
declare const validateNodePendingDrainParams: ProtocolValidator<{
  maxItems?: number | undefined;
}>;
declare const validateNodePendingEnqueueParams: ProtocolValidator<{
  priority?: string | undefined;
  expiresInMs?: number | undefined;
  wake?: boolean | undefined;
  type: string;
  nodeId: string;
}>;
declare const validatePushTestParams: ProtocolValidator<{
  title?: string | undefined;
  body?: string | undefined;
  environment?: string | undefined;
  nodeId: string;
}>;
declare const validateWebPushVapidPublicKeyParams: ProtocolValidator<WebPushVapidPublicKeyParams>;
declare const validateWebPushSubscribeParams: ProtocolValidator<WebPushSubscribeParams>;
declare const validateWebPushUnsubscribeParams: ProtocolValidator<WebPushUnsubscribeParams>;
declare const validateWebPushTestParams: ProtocolValidator<WebPushTestParams>;
declare const validateSecretsResolveParams: ProtocolValidator<{
  allowedPaths?: string[] | undefined;
  forcedActivePaths?: string[] | undefined;
  optionalActivePaths?: string[] | undefined;
  providerOverrides?: {
    webSearch?: string | undefined;
    webFetch?: string | undefined;
  } | undefined;
  commandName: string;
  targetIds: string[];
}>;
declare const validateSecretsResolveResult: ProtocolValidator<{
  ok?: boolean | undefined;
  assignments?: {
    path?: string | undefined;
    value: unknown;
    pathSegments: string[];
  }[] | undefined;
  diagnostics?: string[] | undefined;
  inactiveRefPaths?: string[] | undefined;
}>;
declare const validateSessionsListParams: ProtocolValidator<{
  label?: string | undefined;
  spawnedBy?: string | undefined;
  agentId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  activeMinutes?: number | undefined;
  includeGlobal?: boolean | undefined;
  includeUnknown?: boolean | undefined;
  configuredAgentsOnly?: boolean | undefined;
  includeDerivedTitles?: boolean | undefined;
  includeLastMessage?: boolean | undefined;
  search?: string | undefined;
}>;
declare const validateSessionsCleanupParams: ProtocolValidator<{
  agent?: string | undefined;
  allAgents?: boolean | undefined;
  enforce?: boolean | undefined;
  activeKey?: string | undefined;
  fixMissing?: boolean | undefined;
  fixDmScope?: boolean | undefined;
}>;
declare const validateSessionsPreviewParams: ProtocolValidator<{
  limit?: number | undefined;
  maxChars?: number | undefined;
  keys: string[];
}>;
declare const validateSessionsDescribeParams: ProtocolValidator<{
  includeDerivedTitles?: boolean | undefined;
  includeLastMessage?: boolean | undefined;
  key: string;
}>;
declare const validateSessionsResolveParams: ProtocolValidator<{
  label?: string | undefined;
  spawnedBy?: string | undefined;
  sessionId?: string | undefined;
  agentId?: string | undefined;
  includeGlobal?: boolean | undefined;
  includeUnknown?: boolean | undefined;
  key?: string | undefined;
}>;
declare const validateSessionsCreateParams: ProtocolValidator<{
  message?: string | undefined;
  label?: string | undefined;
  agentId?: string | undefined;
  model?: string | undefined;
  key?: string | undefined;
  parentSessionKey?: string | undefined;
  emitCommandHooks?: boolean | undefined;
  task?: string | undefined;
}>;
declare const validateSessionsSendParams: ProtocolValidator<{
  idempotencyKey?: string | undefined;
  thinking?: string | undefined;
  attachments?: unknown[] | undefined;
  timeoutMs?: number | undefined;
  message: string;
  key: string;
}>;
declare const validateSessionsMessagesSubscribeParams: ProtocolValidator<{
  key: string;
}>;
declare const validateSessionsMessagesUnsubscribeParams: ProtocolValidator<{
  key: string;
}>;
declare const validateSessionsAbortParams: ProtocolValidator<{
  runId?: string | undefined;
  agentId?: string | undefined;
  key?: string | undefined;
}>;
declare const validateSessionsPatchParams: ProtocolValidator<{
  label?: string | null | undefined;
  spawnedBy?: string | null | undefined;
  model?: string | null | undefined;
  thinkingLevel?: string | null | undefined;
  fastMode?: boolean | null | undefined;
  verboseLevel?: string | null | undefined;
  traceLevel?: string | null | undefined;
  reasoningLevel?: string | null | undefined;
  responseUsage?: "off" | "full" | "tokens" | "on" | null | undefined;
  elevatedLevel?: string | null | undefined;
  execHost?: string | null | undefined;
  execSecurity?: string | null | undefined;
  execAsk?: string | null | undefined;
  execNode?: string | null | undefined;
  spawnedWorkspaceDir?: string | null | undefined;
  spawnedCwd?: string | null | undefined;
  spawnDepth?: number | null | undefined;
  subagentRole?: "orchestrator" | "leaf" | null | undefined;
  subagentControlScope?: "none" | "children" | null | undefined;
  inheritedToolAllow?: string[] | null | undefined;
  inheritedToolDeny?: string[] | null | undefined;
  sendPolicy?: "allow" | "deny" | null | undefined;
  groupActivation?: "mention" | "always" | null | undefined;
  key: string;
}>;
declare const validateSessionsPluginPatchParams: ProtocolValidator<{
  value?: unknown;
  unset?: boolean | undefined;
  key: string;
  pluginId: string;
  namespace: string;
}>;
declare const validateSessionsResetParams: ProtocolValidator<{
  reason?: "new" | "reset" | undefined;
  key: string;
}>;
declare const validateSessionsDeleteParams: ProtocolValidator<{
  deleteTranscript?: boolean | undefined;
  emitLifecycleHooks?: boolean | undefined;
  key: string;
}>;
declare const validateSessionsCompactParams: ProtocolValidator<{
  maxLines?: number | undefined;
  key: string;
}>;
declare const validateSessionsCompactionListParams: ProtocolValidator<{
  key: string;
}>;
declare const validateSessionsCompactionGetParams: ProtocolValidator<{
  key: string;
  checkpointId: string;
}>;
declare const validateSessionsCompactionBranchParams: ProtocolValidator<{
  key: string;
  checkpointId: string;
}>;
declare const validateSessionsCompactionRestoreParams: ProtocolValidator<{
  key: string;
  checkpointId: string;
}>;
declare const validateSessionsUsageParams: ProtocolValidator<{
  mode?: "utc" | "gateway" | "specific" | undefined;
  agentId?: string | undefined;
  limit?: number | undefined;
  key?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  range?: "all" | "7d" | "30d" | "90d" | "1y" | undefined;
  groupBy?: "instance" | "family" | undefined;
  includeHistorical?: boolean | undefined;
  utcOffset?: string | undefined;
  includeContextWeight?: boolean | undefined;
}>;
declare const validateTasksListParams: ProtocolValidator<{
  status?: "queued" | "completed" | "running" | "failed" | "cancelled" | "timed_out" | ("queued" | "completed" | "running" | "failed" | "cancelled" | "timed_out")[] | undefined;
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}>;
declare const validateTasksGetParams: ProtocolValidator<{
  taskId: string;
}>;
declare const validateTasksCancelParams: ProtocolValidator<{
  reason?: string | undefined;
  taskId: string;
}>;
declare const validateConfigGetParams: ProtocolValidator<object>;
declare const validateConfigSetParams: ProtocolValidator<{
  baseHash?: string | undefined;
  raw: string;
}>;
declare const validateConfigApplyParams: ProtocolValidator<{
  sessionKey?: string | undefined;
  baseHash?: string | undefined;
  deliveryContext?: {
    channel?: string | undefined;
    accountId?: string | undefined;
    to?: string | undefined;
    threadId?: string | number | undefined;
  } | undefined;
  note?: string | undefined;
  restartDelayMs?: number | undefined;
  raw: string;
}>;
declare const validateConfigPatchParams: ProtocolValidator<{
  sessionKey?: string | undefined;
  baseHash?: string | undefined;
  deliveryContext?: {
    channel?: string | undefined;
    accountId?: string | undefined;
    to?: string | undefined;
    threadId?: string | number | undefined;
  } | undefined;
  note?: string | undefined;
  restartDelayMs?: number | undefined;
  raw: string;
}>;
declare const validateConfigSchemaParams: ProtocolValidator<object>;
declare const validateConfigSchemaLookupParams: ProtocolValidator<{
  path: string;
}>;
declare const validateConfigSchemaLookupResult: ProtocolValidator<{
  reloadKind?: "none" | "restart" | "hot" | undefined;
  hint?: {
    tags?: string[] | undefined;
    label?: string | undefined;
    help?: string | undefined;
    group?: string | undefined;
    order?: number | undefined;
    advanced?: boolean | undefined;
    sensitive?: boolean | undefined;
    placeholder?: string | undefined;
    itemTemplate?: unknown;
  } | undefined;
  hintPath?: string | undefined;
  path: string;
  children: {
    type?: string | string[] | undefined;
    reloadKind?: "none" | "restart" | "hot" | undefined;
    hint?: {
      tags?: string[] | undefined;
      label?: string | undefined;
      help?: string | undefined;
      group?: string | undefined;
      order?: number | undefined;
      advanced?: boolean | undefined;
      sensitive?: boolean | undefined;
      placeholder?: string | undefined;
      itemTemplate?: unknown;
    } | undefined;
    hintPath?: string | undefined;
    required: boolean;
    path: string;
    key: string;
    hasChildren: boolean;
  }[];
  schema: unknown;
}>;
declare const validateWizardStartParams: ProtocolValidator<{
  mode?: "local" | "remote" | undefined;
  workspace?: string | undefined;
}>;
declare const validateWizardNextParams: ProtocolValidator<{
  answer?: {
    value?: unknown;
    stepId: string;
  } | undefined;
  sessionId: string;
}>;
declare const validateWizardCancelParams: ProtocolValidator<{
  sessionId: string;
}>;
declare const validateWizardStatusParams: ProtocolValidator<{
  sessionId: string;
}>;
declare const validateTalkModeParams: ProtocolValidator<{
  phase?: string | undefined;
  enabled: boolean;
}>;
declare const validateTalkEvent: ProtocolValidator<{
  provider?: string | undefined;
  turnId?: string | undefined;
  captureId?: string | undefined;
  final?: boolean | undefined;
  callId?: string | undefined;
  itemId?: string | undefined;
  parentId?: string | undefined;
  id: string;
  type: "session.started" | "session.ready" | "session.closed" | "session.error" | "session.replaced" | "turn.started" | "turn.ended" | "turn.cancelled" | "capture.started" | "capture.stopped" | "capture.cancelled" | "capture.once" | "input.audio.delta" | "input.audio.committed" | "transcript.delta" | "transcript.done" | "output.text.delta" | "output.text.done" | "output.audio.started" | "output.audio.delta" | "output.audio.done" | "tool.call" | "tool.progress" | "tool.result" | "tool.error" | "usage.metrics" | "latency.metrics" | "health.changed";
  mode: "realtime" | "stt-tts" | "transcription";
  payload: unknown;
  seq: number;
  sessionId: string;
  transport: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
  timestamp: string;
  brain: "none" | "agent-consult" | "direct-tools";
}>;
declare const validateTalkCatalogParams: ProtocolValidator<object>;
declare const validateTalkCatalogResult: ProtocolValidator<{
  realtime: {
    activeProvider?: string | undefined;
    providers: {
      modes?: ("realtime" | "stt-tts" | "transcription")[] | undefined;
      transports?: ("webrtc" | "provider-websocket" | "gateway-relay" | "managed-room")[] | undefined;
      brains?: ("none" | "agent-consult" | "direct-tools")[] | undefined;
      models?: string[] | undefined;
      voices?: string[] | undefined;
      defaultModel?: string | undefined;
      inputAudioFormats?: {
        encoding: "pcm16" | "g711_ulaw";
        sampleRateHz: number;
        channels: number;
      }[] | undefined;
      outputAudioFormats?: {
        encoding: "pcm16" | "g711_ulaw";
        sampleRateHz: number;
        channels: number;
      }[] | undefined;
      supportsBrowserSession?: boolean | undefined;
      supportsBargeIn?: boolean | undefined;
      supportsToolCalls?: boolean | undefined;
      supportsVideoFrames?: boolean | undefined;
      supportsSessionResumption?: boolean | undefined;
      id: string;
      label: string;
      configured: boolean;
    }[];
  };
  transcription: {
    activeProvider?: string | undefined;
    providers: {
      modes?: ("realtime" | "stt-tts" | "transcription")[] | undefined;
      transports?: ("webrtc" | "provider-websocket" | "gateway-relay" | "managed-room")[] | undefined;
      brains?: ("none" | "agent-consult" | "direct-tools")[] | undefined;
      models?: string[] | undefined;
      voices?: string[] | undefined;
      defaultModel?: string | undefined;
      inputAudioFormats?: {
        encoding: "pcm16" | "g711_ulaw";
        sampleRateHz: number;
        channels: number;
      }[] | undefined;
      outputAudioFormats?: {
        encoding: "pcm16" | "g711_ulaw";
        sampleRateHz: number;
        channels: number;
      }[] | undefined;
      supportsBrowserSession?: boolean | undefined;
      supportsBargeIn?: boolean | undefined;
      supportsToolCalls?: boolean | undefined;
      supportsVideoFrames?: boolean | undefined;
      supportsSessionResumption?: boolean | undefined;
      id: string;
      label: string;
      configured: boolean;
    }[];
  };
  modes: ("realtime" | "stt-tts" | "transcription")[];
  transports: ("webrtc" | "provider-websocket" | "gateway-relay" | "managed-room")[];
  brains: ("none" | "agent-consult" | "direct-tools")[];
  speech: {
    activeProvider?: string | undefined;
    providers: {
      modes?: ("realtime" | "stt-tts" | "transcription")[] | undefined;
      transports?: ("webrtc" | "provider-websocket" | "gateway-relay" | "managed-room")[] | undefined;
      brains?: ("none" | "agent-consult" | "direct-tools")[] | undefined;
      models?: string[] | undefined;
      voices?: string[] | undefined;
      defaultModel?: string | undefined;
      inputAudioFormats?: {
        encoding: "pcm16" | "g711_ulaw";
        sampleRateHz: number;
        channels: number;
      }[] | undefined;
      outputAudioFormats?: {
        encoding: "pcm16" | "g711_ulaw";
        sampleRateHz: number;
        channels: number;
      }[] | undefined;
      supportsBrowserSession?: boolean | undefined;
      supportsBargeIn?: boolean | undefined;
      supportsToolCalls?: boolean | undefined;
      supportsVideoFrames?: boolean | undefined;
      supportsSessionResumption?: boolean | undefined;
      id: string;
      label: string;
      configured: boolean;
    }[];
  };
}>;
declare const validateTalkConfigParams: ProtocolValidator<{
  includeSecrets?: boolean | undefined;
}>;
declare const validateTalkConfigResult: ProtocolValidator<{
  config: {
    ui?: {
      seamColor?: string | undefined;
    } | undefined;
    talk?: {
      provider?: string | undefined;
      realtime?: {
        mode?: "realtime" | "stt-tts" | "transcription" | undefined;
        provider?: string | undefined;
        model?: string | undefined;
        transport?: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room" | undefined;
        brain?: "none" | "agent-consult" | "direct-tools" | undefined;
        providers?: Record<string, {
          apiKey?: string | {
            id: string;
            provider: string;
            source: "env";
          } | {
            id: string;
            provider: string;
            source: "file";
          } | {
            id: string;
            provider: string;
            source: "exec";
          } | undefined;
        }> | undefined;
        voice?: string | undefined;
        instructions?: string | undefined;
      } | undefined;
      providers?: Record<string, {
        apiKey?: string | {
          id: string;
          provider: string;
          source: "env";
        } | {
          id: string;
          provider: string;
          source: "file";
        } | {
          id: string;
          provider: string;
          source: "exec";
        } | undefined;
      }> | undefined;
      resolved?: {
        provider: string;
        config: {
          apiKey?: string | {
            id: string;
            provider: string;
            source: "env";
          } | {
            id: string;
            provider: string;
            source: "file";
          } | {
            id: string;
            provider: string;
            source: "exec";
          } | undefined;
        };
      } | undefined;
      consultThinkingLevel?: string | undefined;
      consultFastMode?: boolean | undefined;
      speechLocale?: string | undefined;
      interruptOnSpeech?: boolean | undefined;
      silenceTimeoutMs?: number | undefined;
    } | undefined;
    session?: {
      mainKey?: string | undefined;
    } | undefined;
  };
}>;
declare const validateTalkClientCreateParams: ProtocolValidator<{
  mode?: "realtime" | "stt-tts" | "transcription" | undefined;
  sessionKey?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  transport?: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room" | undefined;
  brain?: "none" | "agent-consult" | "direct-tools" | undefined;
  voice?: string | undefined;
  vadThreshold?: number | undefined;
  silenceDurationMs?: number | undefined;
  prefixPaddingMs?: number | undefined;
  reasoningEffort?: string | undefined;
}>;
declare const validateTalkClientCreateResult: ProtocolValidator<{
  model?: string | undefined;
  voice?: string | undefined;
  offerUrl?: string | undefined;
  offerHeaders?: Record<string, string> | undefined;
  expiresAt?: number | undefined;
  provider: string;
  transport: "webrtc";
  clientSecret: string;
} | {
  model?: string | undefined;
  voice?: string | undefined;
  expiresAt?: number | undefined;
  initialMessage?: unknown;
  protocol: string;
  provider: string;
  audio: {
    inputEncoding: "pcm16" | "g711_ulaw";
    inputSampleRateHz: number;
    outputEncoding: "pcm16" | "g711_ulaw";
    outputSampleRateHz: number;
  };
  transport: "provider-websocket";
  clientSecret: string;
  websocketUrl: string;
} | {
  model?: string | undefined;
  voice?: string | undefined;
  expiresAt?: number | undefined;
  provider: string;
  audio: {
    inputEncoding: "pcm16" | "g711_ulaw";
    inputSampleRateHz: number;
    outputEncoding: "pcm16" | "g711_ulaw";
    outputSampleRateHz: number;
  };
  transport: "gateway-relay";
  relaySessionId: string;
} | {
  token?: string | undefined;
  model?: string | undefined;
  voice?: string | undefined;
  expiresAt?: number | undefined;
  provider: string;
  transport: "managed-room";
  roomUrl: string;
}>;
declare const validateTalkClientToolCallParams: ProtocolValidator<{
  relaySessionId?: string | undefined;
  args?: unknown;
  sessionKey: string;
  name: string;
  callId: string;
}>;
declare const validateTalkClientToolCallResult: ProtocolValidator<{
  runId: string;
  idempotencyKey: string;
}>;
declare const validateTalkClientSteerParams: ProtocolValidator<{
  mode?: "status" | "steer" | "cancel" | "followup" | undefined;
  text: string;
  sessionKey: string;
}>;
declare const validateTalkAgentControlResult: ProtocolValidator<{
  reason?: string | undefined;
  sessionId?: string | undefined;
  queued?: boolean | undefined;
  aborted?: boolean | undefined;
  target?: "embedded_run" | "reply_run" | undefined;
  providerResult?: {
    message: string;
    status: "cancelled";
  } | undefined;
  enqueuedAtMs?: number | undefined;
  deliveredAtMs?: number | undefined;
  mode: "status" | "steer" | "cancel" | "followup";
  ok: boolean;
  message: string;
  sessionKey: string;
  active: boolean;
  speak: boolean;
  show: boolean;
  suppress: boolean;
}>;
declare const validateTalkSessionCreateParams: ProtocolValidator<{
  mode?: "realtime" | "stt-tts" | "transcription" | undefined;
  spawnedBy?: string | undefined;
  sessionKey?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  transport?: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room" | undefined;
  brain?: "none" | "agent-consult" | "direct-tools" | undefined;
  voice?: string | undefined;
  vadThreshold?: number | undefined;
  silenceDurationMs?: number | undefined;
  prefixPaddingMs?: number | undefined;
  reasoningEffort?: string | undefined;
  ttlMs?: number | undefined;
}>;
declare const validateTalkSessionCreateResult: ProtocolValidator<{
  token?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  audio?: unknown;
  voice?: string | undefined;
  expiresAt?: number | undefined;
  relaySessionId?: string | undefined;
  roomUrl?: string | undefined;
  transcriptionSessionId?: string | undefined;
  handoffId?: string | undefined;
  roomId?: string | undefined;
  mode: "realtime" | "stt-tts" | "transcription";
  sessionId: string;
  transport: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
  brain: "none" | "agent-consult" | "direct-tools";
}>;
declare const validateTalkSessionJoinParams: ProtocolValidator<{
  token: string;
  sessionId: string;
}>;
declare const validateTalkSessionJoinResult: ProtocolValidator<{
  channel?: string | undefined;
  sessionId?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  voice?: string | undefined;
  target?: string | undefined;
  id: string;
  mode: "realtime" | "stt-tts" | "transcription";
  sessionKey: string;
  transport: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
  createdAt: number;
  brain: "none" | "agent-consult" | "direct-tools";
  expiresAt: number;
  roomUrl: string;
  roomId: string;
  room: {
    activeClientId?: string | undefined;
    activeTurnId?: string | undefined;
    recentTalkEvents: {
      provider?: string | undefined;
      turnId?: string | undefined;
      captureId?: string | undefined;
      final?: boolean | undefined;
      callId?: string | undefined;
      itemId?: string | undefined;
      parentId?: string | undefined;
      id: string;
      type: "session.started" | "session.ready" | "session.closed" | "session.error" | "session.replaced" | "turn.started" | "turn.ended" | "turn.cancelled" | "capture.started" | "capture.stopped" | "capture.cancelled" | "capture.once" | "input.audio.delta" | "input.audio.committed" | "transcript.delta" | "transcript.done" | "output.text.delta" | "output.text.done" | "output.audio.started" | "output.audio.delta" | "output.audio.done" | "tool.call" | "tool.progress" | "tool.result" | "tool.error" | "usage.metrics" | "latency.metrics" | "health.changed";
      mode: "realtime" | "stt-tts" | "transcription";
      payload: unknown;
      seq: number;
      sessionId: string;
      transport: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
      timestamp: string;
      brain: "none" | "agent-consult" | "direct-tools";
    }[];
  };
}>;
declare const validateTalkSessionAppendAudioParams: ProtocolValidator<{
  timestamp?: number | undefined;
  sessionId: string;
  audioBase64: string;
}>;
declare const validateTalkSessionTurnParams: ProtocolValidator<{
  turnId?: string | undefined;
  sessionId: string;
}>;
declare const validateTalkSessionCancelTurnParams: ProtocolValidator<{
  reason?: string | undefined;
  turnId?: string | undefined;
  sessionId: string;
}>;
declare const validateTalkSessionCancelOutputParams: ProtocolValidator<{
  reason?: string | undefined;
  turnId?: string | undefined;
  sessionId: string;
}>;
declare const validateTalkSessionTurnResult: ProtocolValidator<{
  events?: {
    provider?: string | undefined;
    turnId?: string | undefined;
    captureId?: string | undefined;
    final?: boolean | undefined;
    callId?: string | undefined;
    itemId?: string | undefined;
    parentId?: string | undefined;
    id: string;
    type: "session.started" | "session.ready" | "session.closed" | "session.error" | "session.replaced" | "turn.started" | "turn.ended" | "turn.cancelled" | "capture.started" | "capture.stopped" | "capture.cancelled" | "capture.once" | "input.audio.delta" | "input.audio.committed" | "transcript.delta" | "transcript.done" | "output.text.delta" | "output.text.done" | "output.audio.started" | "output.audio.delta" | "output.audio.done" | "tool.call" | "tool.progress" | "tool.result" | "tool.error" | "usage.metrics" | "latency.metrics" | "health.changed";
    mode: "realtime" | "stt-tts" | "transcription";
    payload: unknown;
    seq: number;
    sessionId: string;
    transport: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
    timestamp: string;
    brain: "none" | "agent-consult" | "direct-tools";
  }[] | undefined;
  turnId?: string | undefined;
  ok: boolean;
}>;
declare const validateTalkSessionSteerParams: ProtocolValidator<{
  mode?: "status" | "steer" | "cancel" | "followup" | undefined;
  sessionKey?: string | undefined;
  text: string;
  sessionId: string;
}>;
declare const validateTalkSessionSubmitToolResultParams: ProtocolValidator<{
  options?: {
    suppressResponse?: boolean | undefined;
    willContinue?: boolean | undefined;
  } | undefined;
  sessionId: string;
  result: unknown;
  callId: string;
}>;
declare const validateTalkSessionCloseParams: ProtocolValidator<{
  sessionId: string;
}>;
declare const validateTalkSessionOkResult: ProtocolValidator<{
  ok: boolean;
}>;
declare const validateTalkSpeakParams: ProtocolValidator<{
  voiceId?: string | undefined;
  modelId?: string | undefined;
  outputFormat?: string | undefined;
  speed?: number | undefined;
  rateWpm?: number | undefined;
  stability?: number | undefined;
  similarity?: number | undefined;
  style?: number | undefined;
  speakerBoost?: boolean | undefined;
  seed?: number | undefined;
  normalize?: string | undefined;
  language?: string | undefined;
  latencyTier?: number | undefined;
  text: string;
}>;
declare const validateTalkSpeakResult: ProtocolValidator<{
  mimeType?: string | undefined;
  outputFormat?: string | undefined;
  voiceCompatible?: boolean | undefined;
  fileExtension?: string | undefined;
  provider: string;
  audioBase64: string;
}>;
declare const validateChannelsStatusParams: ProtocolValidator<{
  probe?: boolean | undefined;
  channel?: string | undefined;
  timeoutMs?: number | undefined;
}>;
declare const validateChannelsStartParams: ProtocolValidator<{
  accountId?: string | undefined;
  channel: string;
}>;
declare const validateChannelsStopParams: ProtocolValidator<{
  accountId?: string | undefined;
  channel: string;
}>;
declare const validateChannelsLogoutParams: ProtocolValidator<{
  accountId?: string | undefined;
  channel: string;
}>;
declare const validateModelsListParams: ProtocolValidator<{
  view?: "default" | "all" | "configured" | undefined;
}>;
declare const validateSkillsStatusParams: ProtocolValidator<{
  agentId?: string | undefined;
}>;
declare const validateToolsCatalogParams: ProtocolValidator<{
  agentId?: string | undefined;
  includePlugins?: boolean | undefined;
}>;
declare const validateToolsEffectiveParams: ProtocolValidator<{
  agentId?: string | undefined;
  sessionKey: string;
}>;
declare const validateToolsInvokeParams: ProtocolValidator<{
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  idempotencyKey?: string | undefined;
  confirm?: boolean | undefined;
  args?: Record<string, unknown> | undefined;
  name: string;
}>;
declare const validateSkillsBinsParams: ProtocolValidator<object>;
declare const validateSkillsInstallParams: ProtocolValidator<{
  timeoutMs?: number | undefined;
  dangerouslyForceUnsafeInstall?: boolean | undefined;
  name: string;
  installId: string;
} | {
  version?: string | undefined;
  timeoutMs?: number | undefined;
  force?: boolean | undefined;
  source: "clawhub";
  slug: string;
} | {
  timeoutMs?: number | undefined;
  force?: boolean | undefined;
  sha256?: string | undefined;
  source: "upload";
  slug: string;
  uploadId: string;
}>;
declare const validateSkillsUploadBeginParams: ProtocolValidator<{
  idempotencyKey?: string | undefined;
  force?: boolean | undefined;
  sha256?: string | undefined;
  kind: "skill-archive";
  sizeBytes: number;
  slug: string;
}>;
declare const validateSkillsUploadChunkParams: ProtocolValidator<{
  offset: number;
  uploadId: string;
  dataBase64: string;
}>;
declare const validateSkillsUploadCommitParams: ProtocolValidator<{
  sha256?: string | undefined;
  uploadId: string;
}>;
declare const validateSkillsUpdateParams: ProtocolValidator<{
  enabled?: boolean | undefined;
  env?: Record<string, string> | undefined;
  apiKey?: string | undefined;
  skillKey: string;
} | {
  all?: boolean | undefined;
  slug?: string | undefined;
  source: "clawhub";
}>;
declare const validateSkillsSearchParams: ProtocolValidator<{
  limit?: number | undefined;
  query?: string | undefined;
}>;
declare const validateSkillsDetailParams: ProtocolValidator<{
  slug: string;
}>;
declare const validateSkillsSecurityVerdictsParams: ProtocolValidator<{
  agentId?: string | undefined;
}>;
declare const validateSkillsSkillCardParams: ProtocolValidator<{
  agentId?: string | undefined;
  skillKey: string;
}>;
declare const validateCronListParams: ProtocolValidator<{
  agentId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  enabled?: "all" | "enabled" | "disabled" | undefined;
  query?: string | undefined;
  includeDisabled?: boolean | undefined;
  sortBy?: "name" | "updatedAtMs" | "nextRunAtMs" | undefined;
  sortDir?: "asc" | "desc" | undefined;
}>;
declare const validateCronStatusParams: ProtocolValidator<object>;
declare const validateCronGetParams: ProtocolValidator<{
  id: string;
} | {
  jobId: string;
}>;
declare const validateCronAddParams: ProtocolValidator<{
  sessionKey?: string | null | undefined;
  agentId?: string | null | undefined;
  enabled?: boolean | undefined;
  description?: string | undefined;
  deleteAfterRun?: boolean | undefined;
  delivery?: {
    channel?: string | undefined;
    accountId?: string | undefined;
    to?: string | undefined;
    threadId?: string | number | undefined;
    bestEffort?: boolean | undefined;
    failureDestination?: {
      mode?: "announce" | "webhook" | undefined;
      channel?: string | undefined;
      accountId?: string | undefined;
      to?: string | undefined;
    } | undefined;
    mode: "none";
  } | {
    channel?: string | undefined;
    accountId?: string | undefined;
    to?: string | undefined;
    threadId?: string | number | undefined;
    bestEffort?: boolean | undefined;
    failureDestination?: {
      mode?: "announce" | "webhook" | undefined;
      channel?: string | undefined;
      accountId?: string | undefined;
      to?: string | undefined;
    } | undefined;
    mode: "announce";
  } | {
    channel?: string | undefined;
    accountId?: string | undefined;
    threadId?: string | number | undefined;
    bestEffort?: boolean | undefined;
    failureDestination?: {
      mode?: "announce" | "webhook" | undefined;
      channel?: string | undefined;
      accountId?: string | undefined;
      to?: string | undefined;
    } | undefined;
    mode: "webhook";
    to: string;
  } | undefined;
  failureAlert?: false | {
    mode?: "announce" | "webhook" | undefined;
    channel?: string | undefined;
    accountId?: string | undefined;
    to?: string | undefined;
    after?: number | undefined;
    cooldownMs?: number | undefined;
    includeSkipped?: boolean | undefined;
  } | undefined;
  payload: {
    text: string;
    kind: "systemEvent";
  } | {
    model?: string | undefined;
    thinking?: string | undefined;
    fallbacks?: string[] | undefined;
    timeoutSeconds?: number | undefined;
    allowUnsafeExternalContent?: boolean | undefined;
    lightContext?: boolean | undefined;
    toolsAllow?: unknown;
    message: unknown;
    kind: "agentTurn";
  };
  name: string;
  schedule: {
    kind: "at";
    at: string;
  } | {
    anchorMs?: number | undefined;
    kind: "every";
    everyMs: number;
  } | {
    tz?: string | undefined;
    staggerMs?: number | undefined;
    kind: "cron";
    expr: string;
  };
  sessionTarget: string;
  wakeMode: "now" | "next-heartbeat";
}>;
declare const validateCronUpdateParams: ProtocolValidator<{
  id: string;
} | {
  jobId: string;
}>;
declare const validateCronRemoveParams: ProtocolValidator<{
  id: string;
} | {
  jobId: string;
}>;
declare const validateCronRunParams: ProtocolValidator<{
  id: string;
} | {
  jobId: string;
}>;
declare const validateCronRunsParams: ProtocolValidator<{
  id?: string | undefined;
  scope?: "all" | "job" | undefined;
  status?: "ok" | "error" | "all" | "skipped" | undefined;
  runId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  query?: string | undefined;
  sortDir?: "asc" | "desc" | undefined;
  jobId?: string | undefined;
  statuses?: ("ok" | "error" | "skipped")[] | undefined;
  deliveryStatuses?: ("unknown" | "delivered" | "not-delivered" | "not-requested")[] | undefined;
  deliveryStatus?: "unknown" | "delivered" | "not-delivered" | "not-requested" | undefined;
}>;
declare const validateDevicePairListParams: ProtocolValidator<object>;
declare const validateDevicePairApproveParams: ProtocolValidator<{
  requestId: string;
}>;
declare const validateDevicePairRejectParams: ProtocolValidator<{
  requestId: string;
}>;
declare const validateDevicePairRemoveParams: ProtocolValidator<{
  deviceId: string;
}>;
declare const validateDeviceTokenRotateParams: ProtocolValidator<{
  scopes?: string[] | undefined;
  role: string;
  deviceId: string;
}>;
declare const validateDeviceTokenRevokeParams: ProtocolValidator<{
  role: string;
  deviceId: string;
}>;
declare const validateExecApprovalsGetParams: ProtocolValidator<object>;
declare const validateExecApprovalsSetParams: ProtocolValidator<{
  baseHash?: string | undefined;
  file: {
    defaults?: {
      security?: string | undefined;
      ask?: string | undefined;
      askFallback?: string | undefined;
      autoAllowSkills?: boolean | undefined;
    } | undefined;
    agents?: Record<string, {
      security?: string | undefined;
      ask?: string | undefined;
      askFallback?: string | undefined;
      autoAllowSkills?: boolean | undefined;
      allowlist?: {
        id?: string | undefined;
        source?: "allow-always" | undefined;
        commandText?: string | undefined;
        argPattern?: string | undefined;
        lastUsedAt?: number | undefined;
        lastUsedCommand?: string | undefined;
        lastResolvedPath?: string | undefined;
        pattern: string;
      }[] | undefined;
    }> | undefined;
    socket?: {
      token?: string | undefined;
      path?: string | undefined;
    } | undefined;
    version: 1;
  };
}>;
declare const validateExecApprovalGetParams: ProtocolValidator<{
  id: string;
}>;
declare const validateExecApprovalRequestParams: ProtocolValidator<{
  id?: string | undefined;
  host?: string | null | undefined;
  sessionKey?: string | null | undefined;
  agentId?: string | null | undefined;
  timeoutMs?: number | undefined;
  nodeId?: string | null | undefined;
  command?: string | undefined;
  env?: Record<string, string> | undefined;
  security?: string | null | undefined;
  ask?: string | null | undefined;
  commandArgv?: string[] | undefined;
  systemRunPlan?: {
    commandPreview?: string | null | undefined;
    mutableFileOperand?: {
      path: string;
      sha256: string;
      argvIndex: number;
    } | null | undefined;
    sessionKey: string | null;
    agentId: string | null;
    commandText: string;
    argv: string[];
    cwd: string | null;
  } | undefined;
  cwd?: string | null | undefined;
  warningText?: string | null | undefined;
  commandSpans?: {
    startIndex: number;
    endIndex: number;
  }[] | undefined;
  resolvedPath?: string | null | undefined;
  turnSourceChannel?: string | null | undefined;
  turnSourceTo?: string | null | undefined;
  turnSourceAccountId?: string | null | undefined;
  turnSourceThreadId?: string | number | null | undefined;
  twoPhase?: boolean | undefined;
}>;
declare const validateExecApprovalResolveParams: ProtocolValidator<{
  id: string;
  decision: string;
}>;
declare const validatePluginApprovalRequestParams: ProtocolValidator<{
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  timeoutMs?: number | undefined;
  pluginId?: string | undefined;
  severity?: string | undefined;
  toolName?: string | undefined;
  turnSourceChannel?: string | undefined;
  turnSourceTo?: string | undefined;
  turnSourceAccountId?: string | undefined;
  turnSourceThreadId?: string | number | undefined;
  twoPhase?: boolean | undefined;
  toolCallId?: string | undefined;
  allowedDecisions?: string[] | undefined;
  title: string;
  description: string;
}>;
declare const validatePluginApprovalResolveParams: ProtocolValidator<{
  id: string;
  decision: string;
}>;
declare const validatePluginsUiDescriptorsParams: ProtocolValidator<object>;
declare const validatePluginsSessionActionParams: ProtocolValidator<{
  payload?: unknown;
  sessionKey?: string | undefined;
  pluginId: string;
  actionId: string;
}>;
declare const validatePluginsSessionActionResult: ProtocolValidator<{
  result?: unknown;
  continueAgent?: boolean | undefined;
  reply?: unknown;
  ok: true;
} | {
  code?: string | undefined;
  details?: unknown;
  ok: false;
  error: string;
}>;
declare const validateExecApprovalsNodeGetParams: ProtocolValidator<{
  nodeId: string;
}>;
declare const validateExecApprovalsNodeSetParams: ProtocolValidator<{
  baseHash?: string | undefined;
  file: {
    defaults?: {
      security?: string | undefined;
      ask?: string | undefined;
      askFallback?: string | undefined;
      autoAllowSkills?: boolean | undefined;
    } | undefined;
    agents?: Record<string, {
      security?: string | undefined;
      ask?: string | undefined;
      askFallback?: string | undefined;
      autoAllowSkills?: boolean | undefined;
      allowlist?: {
        id?: string | undefined;
        source?: "allow-always" | undefined;
        commandText?: string | undefined;
        argPattern?: string | undefined;
        lastUsedAt?: number | undefined;
        lastUsedCommand?: string | undefined;
        lastResolvedPath?: string | undefined;
        pattern: string;
      }[] | undefined;
    }> | undefined;
    socket?: {
      token?: string | undefined;
      path?: string | undefined;
    } | undefined;
    version: 1;
  };
  nodeId: string;
}>;
declare const validateLogsTailParams: ProtocolValidator<{
  limit?: number | undefined;
  cursor?: number | undefined;
  maxBytes?: number | undefined;
}>;
declare const validateChatHistoryParams: ProtocolValidator<unknown>;
declare const validateChatSendParams: ProtocolValidator<unknown>;
declare const validateChatAbortParams: ProtocolValidator<{
  runId?: string | undefined;
  sessionKey: string;
}>;
declare const validateChatInjectParams: ProtocolValidator<{
  label?: string | undefined;
  message: string;
  sessionKey: string;
}>;
declare const validateChatEvent: ProtocolValidator<unknown>;
declare const validateUpdateStatusParams: ProtocolValidator<object>;
declare const validateUpdateRunParams: ProtocolValidator<{
  sessionKey?: string | undefined;
  timeoutMs?: number | undefined;
  deliveryContext?: {
    channel?: string | undefined;
    accountId?: string | undefined;
    to?: string | undefined;
    threadId?: string | number | undefined;
  } | undefined;
  note?: string | undefined;
  restartDelayMs?: number | undefined;
  continuationMessage?: string | undefined;
}>;
declare const validateWebLoginStartParams: ProtocolValidator<{
  accountId?: string | undefined;
  timeoutMs?: number | undefined;
  force?: boolean | undefined;
  verbose?: boolean | undefined;
}>;
declare const validateWebLoginWaitParams: ProtocolValidator<{
  accountId?: string | undefined;
  timeoutMs?: number | undefined;
  currentQrDataUrl?: string | undefined;
}>;
declare function formatValidationErrors(errors: ValidationError[] | null | undefined): string;
type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: Record<string, unknown>;
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: GatewayAgentRuntime;
  };
};
type GatewayAgentRuntime = {
  id: string;
  fallback?: "openclaw" | "none";
  source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit" | "session-key";
};
//#endregion
export { type AgentEvent, AgentEventSchema, type AgentIdentityParams, AgentIdentityParamsSchema, type AgentIdentityResult, AgentIdentityResultSchema, AgentParamsSchema, type AgentSummary, AgentSummarySchema, type AgentWaitParams, type AgentsCreateParams, AgentsCreateParamsSchema, type AgentsCreateResult, AgentsCreateResultSchema, type AgentsDeleteParams, AgentsDeleteParamsSchema, type AgentsDeleteResult, AgentsDeleteResultSchema, type AgentsFileEntry, AgentsFileEntrySchema, type AgentsFilesGetParams, AgentsFilesGetParamsSchema, type AgentsFilesGetResult, AgentsFilesGetResultSchema, type AgentsFilesListParams, AgentsFilesListParamsSchema, type AgentsFilesListResult, AgentsFilesListResultSchema, type AgentsFilesSetParams, AgentsFilesSetParamsSchema, type AgentsFilesSetResult, AgentsFilesSetResultSchema, type AgentsListParams, AgentsListParamsSchema, type AgentsListResult, AgentsListResultSchema, type AgentsUpdateParams, AgentsUpdateParamsSchema, type AgentsUpdateResult, AgentsUpdateResultSchema, type ArtifactSummary, ArtifactSummarySchema, type ArtifactsDownloadParams, ArtifactsDownloadParamsSchema, type ArtifactsDownloadResult, type ArtifactsGetParams, ArtifactsGetParamsSchema, type ArtifactsGetResult, type ArtifactsListParams, ArtifactsListParamsSchema, type ArtifactsListResult, type ChannelsLogoutParams, ChannelsLogoutParamsSchema, type ChannelsStartParams, ChannelsStartParamsSchema, type ChannelsStatusParams, ChannelsStatusParamsSchema, type ChannelsStatusResult, ChannelsStatusResultSchema, type ChannelsStopParams, ChannelsStopParamsSchema, type ChatEvent, ChatEventSchema, ChatHistoryParamsSchema, type ChatInjectParams, ChatInjectParamsSchema, ChatSendParamsSchema, type CommandEntry, type CommandsListParams, CommandsListParamsSchema, type CommandsListResult, CommandsListResultSchema, type ConfigApplyParams, ConfigApplyParamsSchema, type ConfigGetParams, ConfigGetParamsSchema, type ConfigPatchParams, ConfigPatchParamsSchema, ConfigSchemaLookupParamsSchema, ConfigSchemaLookupResultSchema, type ConfigSchemaParams, ConfigSchemaParamsSchema, type ConfigSchemaResponse, ConfigSchemaResponseSchema, type ConfigSetParams, ConfigSetParamsSchema, type ConnectParams, ConnectParamsSchema, type CronAddParams, CronAddParamsSchema, type CronGetParams, CronGetParamsSchema, type CronJob, CronJobSchema, type CronListParams, CronListParamsSchema, type CronRemoveParams, CronRemoveParamsSchema, type CronRunLogEntry, type CronRunParams, CronRunParamsSchema, type CronRunsParams, CronRunsParamsSchema, type CronStatusParams, CronStatusParamsSchema, type CronUpdateParams, CronUpdateParamsSchema, type DevicePairApproveParams, type DevicePairListParams, type DevicePairRejectParams, type EnvironmentStatus, EnvironmentStatusSchema, type EnvironmentSummary, EnvironmentSummarySchema, type EnvironmentsListParams, EnvironmentsListParamsSchema, type EnvironmentsListResult, EnvironmentsListResultSchema, type EnvironmentsStatusParams, EnvironmentsStatusParamsSchema, type EnvironmentsStatusResult, EnvironmentsStatusResultSchema, ErrorCodes, type ErrorShape, ErrorShapeSchema, type EventFrame, EventFrameSchema, type ExecApprovalGetParams, ExecApprovalGetParamsSchema, type ExecApprovalRequestParams, ExecApprovalRequestParamsSchema, type ExecApprovalResolveParams, ExecApprovalResolveParamsSchema, type ExecApprovalsGetParams, ExecApprovalsGetParamsSchema, type ExecApprovalsSetParams, ExecApprovalsSetParamsSchema, type ExecApprovalsSnapshot, type GatewayFrame, GatewayFrameSchema, type HelloOk, HelloOkSchema, type LogsTailParams, LogsTailParamsSchema, type LogsTailResult, LogsTailResultSchema, MIN_CLIENT_PROTOCOL_VERSION, MIN_PROBE_PROTOCOL_VERSION, MessageActionParamsSchema, ModelsListParamsSchema, type NodeEventParams, type NodeEventResult, NodeEventResultSchema, type NodeInvokeParams, NodeInvokeParamsSchema, type NodeInvokeResultParams, type NodeListParams, NodeListParamsSchema, type NodePairApproveParams, NodePairApproveParamsSchema, type NodePairListParams, NodePairListParamsSchema, type NodePairRejectParams, NodePairRejectParamsSchema, type NodePairRemoveParams, NodePairRemoveParamsSchema, type NodePairRequestParams, NodePairRequestParamsSchema, type NodePairVerifyParams, NodePairVerifyParamsSchema, NodePendingAckParamsSchema, type NodePendingDrainParams, NodePendingDrainParamsSchema, type NodePendingDrainResult, NodePendingDrainResultSchema, type NodePendingEnqueueParams, NodePendingEnqueueParamsSchema, type NodePendingEnqueueResult, NodePendingEnqueueResultSchema, type NodePresenceAlivePayload, NodePresenceAlivePayloadSchema, type NodePresenceAliveReason, NodePresenceAliveReasonSchema, PROTOCOL_VERSION, type PluginsSessionActionParams, PluginsSessionActionParamsSchema, type PluginsSessionActionResult, PluginsSessionActionResultSchema, PluginsUiDescriptorsParamsSchema, type PollParams, PollParamsSchema, type PresenceEntry, PresenceEntrySchema, ProtocolSchemas, ProtocolValidator, PushTestParamsSchema, PushTestResultSchema, type RequestFrame, RequestFrameSchema, type ResponseFrame, ResponseFrameSchema, SendParamsSchema, type SessionOperationEvent, SessionsAbortParamsSchema, type SessionsCleanupParams, SessionsCleanupParamsSchema, type SessionsCompactParams, SessionsCompactParamsSchema, SessionsCompactionBranchParamsSchema, SessionsCompactionGetParamsSchema, SessionsCompactionListParamsSchema, SessionsCompactionRestoreParamsSchema, SessionsCreateParamsSchema, type SessionsDeleteParams, SessionsDeleteParamsSchema, type SessionsDescribeParams, SessionsDescribeParamsSchema, type SessionsListParams, SessionsListParamsSchema, type SessionsPatchParams, SessionsPatchParamsSchema, type SessionsPatchResult, SessionsPluginPatchParamsSchema, type SessionsPreviewParams, SessionsPreviewParamsSchema, type SessionsResetParams, SessionsResetParamsSchema, type SessionsResolveParams, SessionsResolveParamsSchema, SessionsSendParamsSchema, type SessionsUsageParams, SessionsUsageParamsSchema, type ShutdownEvent, ShutdownEventSchema, type SkillsBinsParams, type SkillsBinsResult, type SkillsDetailParams, SkillsDetailParamsSchema, type SkillsDetailResult, SkillsDetailResultSchema, type SkillsInstallParams, SkillsInstallParamsSchema, type SkillsSearchParams, SkillsSearchParamsSchema, type SkillsSearchResult, SkillsSearchResultSchema, type SkillsSecurityVerdictsParams, SkillsSecurityVerdictsParamsSchema, type SkillsSecurityVerdictsResult, SkillsSecurityVerdictsResultSchema, type SkillsSkillCardParams, SkillsSkillCardParamsSchema, type SkillsSkillCardResult, SkillsSkillCardResultSchema, type SkillsStatusParams, SkillsStatusParamsSchema, type SkillsUpdateParams, SkillsUpdateParamsSchema, type SkillsUploadBeginParams, SkillsUploadBeginParamsSchema, type SkillsUploadChunkParams, SkillsUploadChunkParamsSchema, type SkillsUploadCommitParams, SkillsUploadCommitParamsSchema, type Snapshot, SnapshotSchema, type StateVersion, StateVersionSchema, type TalkAgentControlResult, TalkAgentControlResultSchema, type TalkCatalogParams, TalkCatalogParamsSchema, type TalkCatalogResult, TalkCatalogResultSchema, type TalkClientCreateParams, TalkClientCreateParamsSchema, type TalkClientCreateResult, TalkClientCreateResultSchema, type TalkClientSteerParams, TalkClientSteerParamsSchema, type TalkClientToolCallParams, TalkClientToolCallParamsSchema, type TalkClientToolCallResult, TalkClientToolCallResultSchema, type TalkConfigParams, TalkConfigParamsSchema, type TalkConfigResult, TalkConfigResultSchema, TalkEventSchema, type TalkModeParams, type TalkSessionAppendAudioParams, TalkSessionAppendAudioParamsSchema, type TalkSessionCancelOutputParams, TalkSessionCancelOutputParamsSchema, type TalkSessionCancelTurnParams, TalkSessionCancelTurnParamsSchema, type TalkSessionCloseParams, TalkSessionCloseParamsSchema, type TalkSessionCreateParams, TalkSessionCreateParamsSchema, type TalkSessionCreateResult, TalkSessionCreateResultSchema, type TalkSessionJoinParams, TalkSessionJoinParamsSchema, type TalkSessionJoinResult, TalkSessionJoinResultSchema, type TalkSessionOkResult, TalkSessionOkResultSchema, type TalkSessionSteerParams, TalkSessionSteerParamsSchema, type TalkSessionSubmitToolResultParams, TalkSessionSubmitToolResultParamsSchema, type TalkSessionTurnParams, TalkSessionTurnParamsSchema, type TalkSessionTurnResult, TalkSessionTurnResultSchema, type TalkSpeakParams, TalkSpeakParamsSchema, type TalkSpeakResult, TalkSpeakResultSchema, type TaskSummary, TaskSummarySchema, type TasksCancelParams, TasksCancelParamsSchema, type TasksCancelResult, TasksCancelResultSchema, type TasksGetParams, TasksGetParamsSchema, type TasksGetResult, TasksGetResultSchema, type TasksListParams, TasksListParamsSchema, type TasksListResult, TasksListResultSchema, type TickEvent, TickEventSchema, type ToolsCatalogParams, ToolsCatalogParamsSchema, type ToolsCatalogResult, type ToolsEffectiveParams, ToolsEffectiveParamsSchema, type ToolsEffectiveResult, type ToolsInvokeParams, ToolsInvokeParamsSchema, type ToolsInvokeResult, type UpdateRunParams, UpdateRunParamsSchema, type UpdateStatusParams, UpdateStatusParamsSchema, ValidationError, type WakeParams, WakeParamsSchema, type WebLoginStartParams, WebLoginStartParamsSchema, type WebLoginWaitParams, WebLoginWaitParamsSchema, type WebPushSubscribeParams, WebPushSubscribeParamsSchema, type WebPushTestParams, WebPushTestParamsSchema, type WebPushUnsubscribeParams, WebPushUnsubscribeParamsSchema, type WebPushVapidPublicKeyParams, WebPushVapidPublicKeyParamsSchema, type WizardCancelParams, WizardCancelParamsSchema, type WizardNextParams, WizardNextParamsSchema, type WizardNextResult, WizardNextResultSchema, type WizardStartParams, WizardStartParamsSchema, type WizardStartResult, WizardStartResultSchema, type WizardStatusParams, WizardStatusParamsSchema, type WizardStatusResult, WizardStatusResultSchema, type WizardStep, WizardStepSchema, errorShape, formatValidationErrors, validateAgentIdentityParams, validateAgentParams, validateAgentWaitParams, validateAgentsCreateParams, validateAgentsDeleteParams, validateAgentsFilesGetParams, validateAgentsFilesListParams, validateAgentsFilesSetParams, validateAgentsListParams, validateAgentsUpdateParams, validateArtifactsDownloadParams, validateArtifactsGetParams, validateArtifactsListParams, validateChannelsLogoutParams, validateChannelsStartParams, validateChannelsStatusParams, validateChannelsStopParams, validateChatAbortParams, validateChatEvent, validateChatHistoryParams, validateChatInjectParams, validateChatSendParams, validateCommandsListParams, validateConfigApplyParams, validateConfigGetParams, validateConfigPatchParams, validateConfigSchemaLookupParams, validateConfigSchemaLookupResult, validateConfigSchemaParams, validateConfigSetParams, validateConnectParams, validateCronAddParams, validateCronGetParams, validateCronListParams, validateCronRemoveParams, validateCronRunParams, validateCronRunsParams, validateCronStatusParams, validateCronUpdateParams, validateDevicePairApproveParams, validateDevicePairListParams, validateDevicePairRejectParams, validateDevicePairRemoveParams, validateDeviceTokenRevokeParams, validateDeviceTokenRotateParams, validateEnvironmentsListParams, validateEnvironmentsStatusParams, validateEventFrame, validateExecApprovalGetParams, validateExecApprovalRequestParams, validateExecApprovalResolveParams, validateExecApprovalsGetParams, validateExecApprovalsNodeGetParams, validateExecApprovalsNodeSetParams, validateExecApprovalsSetParams, validateLogsTailParams, validateMessageActionParams, validateModelsListParams, validateNodeDescribeParams, validateNodeEventParams, validateNodeEventResult, validateNodeInvokeParams, validateNodeInvokeResultParams, validateNodeListParams, validateNodePairApproveParams, validateNodePairListParams, validateNodePairRejectParams, validateNodePairRemoveParams, validateNodePairRequestParams, validateNodePairVerifyParams, validateNodePendingAckParams, validateNodePendingDrainParams, validateNodePendingEnqueueParams, validateNodePresenceAlivePayload, validateNodeRenameParams, validatePluginApprovalRequestParams, validatePluginApprovalResolveParams, validatePluginsSessionActionParams, validatePluginsSessionActionResult, validatePluginsUiDescriptorsParams, validatePollParams, validatePushTestParams, validateRequestFrame, validateResponseFrame, validateSecretsResolveParams, validateSecretsResolveResult, validateSendParams, validateSessionsAbortParams, validateSessionsCleanupParams, validateSessionsCompactParams, validateSessionsCompactionBranchParams, validateSessionsCompactionGetParams, validateSessionsCompactionListParams, validateSessionsCompactionRestoreParams, validateSessionsCreateParams, validateSessionsDeleteParams, validateSessionsDescribeParams, validateSessionsListParams, validateSessionsMessagesSubscribeParams, validateSessionsMessagesUnsubscribeParams, validateSessionsPatchParams, validateSessionsPluginPatchParams, validateSessionsPreviewParams, validateSessionsResetParams, validateSessionsResolveParams, validateSessionsSendParams, validateSessionsUsageParams, validateSkillsBinsParams, validateSkillsDetailParams, validateSkillsInstallParams, validateSkillsSearchParams, validateSkillsSecurityVerdictsParams, validateSkillsSkillCardParams, validateSkillsStatusParams, validateSkillsUpdateParams, validateSkillsUploadBeginParams, validateSkillsUploadChunkParams, validateSkillsUploadCommitParams, validateTalkAgentControlResult, validateTalkCatalogParams, validateTalkCatalogResult, validateTalkClientCreateParams, validateTalkClientCreateResult, validateTalkClientSteerParams, validateTalkClientToolCallParams, validateTalkClientToolCallResult, validateTalkConfigParams, validateTalkConfigResult, validateTalkEvent, validateTalkModeParams, validateTalkSessionAppendAudioParams, validateTalkSessionCancelOutputParams, validateTalkSessionCancelTurnParams, validateTalkSessionCloseParams, validateTalkSessionCreateParams, validateTalkSessionCreateResult, validateTalkSessionJoinParams, validateTalkSessionJoinResult, validateTalkSessionOkResult, validateTalkSessionSteerParams, validateTalkSessionSubmitToolResultParams, validateTalkSessionTurnParams, validateTalkSessionTurnResult, validateTalkSpeakParams, validateTalkSpeakResult, validateTasksCancelParams, validateTasksGetParams, validateTasksListParams, validateToolsCatalogParams, validateToolsEffectiveParams, validateToolsInvokeParams, validateUpdateRunParams, validateUpdateStatusParams, validateWakeParams, validateWebLoginStartParams, validateWebLoginWaitParams, validateWebPushSubscribeParams, validateWebPushTestParams, validateWebPushUnsubscribeParams, validateWebPushVapidPublicKeyParams, validateWizardCancelParams, validateWizardNextParams, validateWizardStartParams, validateWizardStatusParams };