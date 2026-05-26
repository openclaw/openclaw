import { o as SessionEntry } from "./types-ChLEnNVH.js";
import { n as AgentEventPayload, r as AgentEventStream } from "./agent-events-DtKTaaH3.js";
import { M as PluginHookBeforeToolCallEvent, N as PluginHookBeforeToolCallResult, Rt as PluginJsonValue, _t as PluginHookToolContext } from "./hook-types-BKz-S4lu.js";
import { ut as ErrorShape } from "./types-DOsLYgS6.js";
import AjvPkg, { ErrorObject } from "ajv";
import { Static, Type } from "typebox";

//#region src/gateway/operator-scopes.d.ts
declare const ADMIN_SCOPE: "operator.admin";
declare const READ_SCOPE: "operator.read";
declare const WRITE_SCOPE: "operator.write";
declare const APPROVALS_SCOPE: "operator.approvals";
declare const PAIRING_SCOPE: "operator.pairing";
declare const TALK_SECRETS_SCOPE: "operator.talk.secrets";
type OperatorScope = typeof ADMIN_SCOPE | typeof READ_SCOPE | typeof WRITE_SCOPE | typeof APPROVALS_SCOPE | typeof PAIRING_SCOPE | typeof TALK_SECRETS_SCOPE;
//#endregion
//#region src/plugins/host-hooks.d.ts
type PluginHostCleanupReason = "disable" | "reset" | "delete" | "restart";
type PluginSessionExtensionProjectionContext = {
  sessionKey: string;
  sessionId?: string;
  state: PluginJsonValue | undefined;
};
type PluginSessionExtensionRegistration = {
  namespace: string;
  description: string;
  project?: (ctx: PluginSessionExtensionProjectionContext) => PluginJsonValue | undefined;
  cleanup?: (ctx: {
    reason: PluginHostCleanupReason;
    sessionKey?: string;
  }) => void | Promise<void>;
  /**
   * When set, after every successful `patchSessionExtension` the projected
   * value is mirrored to `SessionEntry[<slotKey>]` so non-plugin readers
   * can consume the typed slot without reaching into
   * `pluginExtensions[pluginId][namespace]`.
   *
   * The slot is a read-only mirror: writes always go through
   * `patchSessionExtension`; the host overwrites the slot value on every
   * subsequent patch.
   */
  sessionEntrySlotKey?: string;
  /**
   * Optional JSON-compatible schema describing the projected slot value.
   * Purely informational at this layer; clients may use it to validate the
   * mirrored slot against a contract.
   */
  sessionEntrySlotSchema?: PluginJsonValue;
};
type PluginSessionExtensionProjection = {
  pluginId: string;
  namespace: string;
  value: PluginJsonValue;
};
type PluginToolPolicyDecision = PluginHookBeforeToolCallResult | {
  allow?: boolean;
  reason?: string;
};
type PluginTrustedToolPolicyRegistration = {
  id: string;
  description: string;
  evaluate: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => PluginToolPolicyDecision | void | Promise<PluginToolPolicyDecision | void>;
};
type PluginToolMetadataRegistration = {
  toolName: string;
  displayName?: string;
  description?: string;
  risk?: "low" | "medium" | "high";
  tags?: string[];
};
type PluginControlUiDescriptor = {
  id: string;
  surface: "session" | "tool" | "run" | "settings";
  label: string;
  description?: string;
  placement?: string;
  schema?: PluginJsonValue;
  requiredScopes?: OperatorScope[];
};
type PluginSessionActionContext = {
  pluginId: string;
  actionId: string;
  sessionKey?: string;
  payload?: PluginJsonValue;
  client?: {
    connId?: string;
    scopes: string[];
  };
};
type PluginSessionActionResult = {
  ok?: true;
  result?: PluginJsonValue;
  reply?: PluginJsonValue;
  continueAgent?: boolean;
} | {
  ok: false;
  error: string;
  code?: string;
  details?: PluginJsonValue;
};
type PluginSessionActionRegistration = {
  id: string;
  description?: string;
  schema?: PluginJsonValue;
  requiredScopes?: OperatorScope[];
  handler: (ctx: PluginSessionActionContext) => PluginSessionActionResult | void | Promise<PluginSessionActionResult | void>;
};
type PluginRuntimeLifecycleRegistration = {
  id: string;
  description?: string;
  cleanup?: (ctx: {
    reason: PluginHostCleanupReason;
    sessionKey?: string;
    runId?: string;
  }) => void | Promise<void>;
};
type PluginAgentEventSubscriptionRegistration = {
  id: string;
  description?: string;
  streams?: AgentEventStream[];
  handle: (event: AgentEventPayload, ctx: {
    getRunContext: <T extends PluginJsonValue = PluginJsonValue>(namespace: string) => T | undefined;
    setRunContext: (namespace: string, value: PluginJsonValue) => void;
    clearRunContext: (namespace?: string) => void;
  }) => void | Promise<void>;
};
type PluginAgentEventEmitParams = {
  runId: string;
  stream: AgentEventStream;
  data: PluginJsonValue;
  sessionKey?: string;
};
type PluginAgentEventEmitResult = {
  emitted: true;
  stream: AgentEventStream;
} | {
  emitted: false;
  reason: string;
};
type PluginRunContextPatch = {
  runId: string;
  namespace: string;
  value?: PluginJsonValue;
  unset?: boolean;
};
type PluginRunContextGetParams = {
  runId: string;
  namespace: string;
};
type PluginSessionSchedulerJobRegistration = {
  id: string;
  sessionKey: string;
  kind: string;
  description?: string;
  cleanup?: (ctx: {
    reason: PluginHostCleanupReason;
    sessionKey: string;
    jobId: string;
  }) => void | Promise<void>;
};
type PluginSessionSchedulerJobHandle = {
  id: string;
  pluginId: string;
  sessionKey: string;
  kind: string;
};
type PluginSessionAttachmentFile = {
  path: string;
};
type PluginAttachmentChannelHints = {
  telegram?: {
    parseMode?: "HTML";
    disableNotification?: boolean;
    /**
     * Require host-side detection to match this MIME before forcing document delivery.
     * Mismatched files are rejected before the outbound adapter is called.
     */
    forceDocumentMime?: string;
  };
  slack?: {
    threadTs?: string;
  };
};
type PluginSessionAttachmentCaptionFormat = "plain" | "html" | "markdown";
type PluginSessionAttachmentParams = {
  sessionKey: string;
  files: PluginSessionAttachmentFile[];
  text?: string;
  threadId?: string | number;
  forceDocument?: boolean;
  maxBytes?: number;
  captionFormat?: PluginSessionAttachmentCaptionFormat;
  channelHints?: PluginAttachmentChannelHints;
};
type PluginSessionAttachmentResult = {
  ok: true;
  channel: string;
  deliveredTo: string;
  count: number;
} | {
  ok: false;
  error: string;
};
type PluginSessionTurnScheduleCommonParams = {
  sessionKey: string;
  message: string;
  agentId?: string;
  deliveryMode?: "none" | "announce";
  name?: string; /** Optional cleanup tag. Reserved cron-name delimiters like `:` are rejected. */
  tag?: string;
};
type PluginSessionTurnScheduleParams = ({
  at: string | number | Date;
  deleteAfterRun?: boolean;
} & PluginSessionTurnScheduleCommonParams) | ({
  delayMs: number;
  deleteAfterRun?: boolean;
} & PluginSessionTurnScheduleCommonParams) | ({
  cron: string;
  tz?: string;
  deleteAfterRun?: false;
} & PluginSessionTurnScheduleCommonParams);
type PluginSessionTurnUnscheduleByTagParams = {
  sessionKey: string;
  tag: string;
};
type PluginSessionTurnUnscheduleByTagResult = {
  removed: number;
  failed: number;
};
//#endregion
//#region src/shared/session-types.d.ts
type GatewayAgentRuntime = {
  id: string;
  fallback?: "pi" | "none";
  source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit" | "session-key";
};
type SessionsPatchResultBase<TEntry> = {
  ok: true;
  path: string;
  key: string;
  entry: TEntry;
};
//#endregion
//#region src/gateway/session-utils.types.d.ts
type SessionsPatchResult = SessionsPatchResultBase<SessionEntry> & {
  entry: SessionEntry;
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: GatewayAgentRuntime;
  };
};
//#endregion
//#region src/gateway/protocol/schema/agent.d.ts
declare const AgentEventSchema: Type.TObject<{
  runId: Type.TString;
  seq: Type.TInteger;
  stream: Type.TString;
  ts: Type.TInteger;
  spawnedBy: Type.TOptional<Type.TString>;
  isHeartbeat: Type.TOptional<Type.TBoolean>;
  data: Type.TRecord<"^.*$", Type.TUnknown>;
}>;
declare const MessageActionParamsSchema: Type.TObject<{
  channel: Type.TString;
  action: Type.TString;
  params: Type.TRecord<"^.*$", Type.TUnknown>;
  accountId: Type.TOptional<Type.TString>;
  requesterSenderId: Type.TOptional<Type.TString>;
  senderIsOwner: Type.TOptional<Type.TBoolean>;
  sessionKey: Type.TOptional<Type.TString>;
  sessionId: Type.TOptional<Type.TString>;
  inboundTurnKind: Type.TOptional<Type.TString>;
  agentId: Type.TOptional<Type.TString>;
  toolContext: Type.TOptional<Type.TObject<{
    currentChannelId: Type.TOptional<Type.TString>;
    currentGraphChannelId: Type.TOptional<Type.TString>;
    currentChannelProvider: Type.TOptional<Type.TString>;
    currentThreadTs: Type.TOptional<Type.TString>;
    currentMessageId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    replyToMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"off">, Type.TLiteral<"first">, Type.TLiteral<"all">, Type.TLiteral<"batched">]>>;
    hasRepliedRef: Type.TOptional<Type.TObject<{
      value: Type.TBoolean;
    }>>;
    skipCrossContextDecoration: Type.TOptional<Type.TBoolean>;
  }>>;
  idempotencyKey: Type.TString;
}>;
declare const SendParamsSchema: Type.TObject<{
  to: Type.TString;
  message: Type.TOptional<Type.TString>;
  mediaUrl: Type.TOptional<Type.TString>;
  mediaUrls: Type.TOptional<Type.TArray<Type.TString>>;
  asVoice: Type.TOptional<Type.TBoolean>;
  gifPlayback: Type.TOptional<Type.TBoolean>;
  channel: Type.TOptional<Type.TString>;
  accountId: Type.TOptional<Type.TString>; /** Optional agent id for per-agent media root resolution on gateway sends. */
  agentId: Type.TOptional<Type.TString>; /** Reply target message id for native quoted/threaded sends where supported. */
  replyToId: Type.TOptional<Type.TString>; /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
  threadId: Type.TOptional<Type.TString>; /** Force document-style media sends where supported. */
  forceDocument: Type.TOptional<Type.TBoolean>; /** Send silently (no notification) where supported. */
  silent: Type.TOptional<Type.TBoolean>; /** Channel-specific parse mode for formatted text. */
  parseMode: Type.TOptional<Type.TLiteral<"HTML">>; /** Optional session key for mirroring delivered output back into the transcript. */
  sessionKey: Type.TOptional<Type.TString>;
  idempotencyKey: Type.TString;
}>;
declare const PollParamsSchema: Type.TObject<{
  to: Type.TString;
  question: Type.TString;
  options: Type.TArray<Type.TString>;
  maxSelections: Type.TOptional<Type.TInteger>; /** Poll duration in seconds (channel-specific limits may apply). */
  durationSeconds: Type.TOptional<Type.TInteger>;
  durationHours: Type.TOptional<Type.TInteger>; /** Send silently (no notification) where supported. */
  silent: Type.TOptional<Type.TBoolean>; /** Poll anonymity where supported (e.g. Telegram polls default to anonymous). */
  isAnonymous: Type.TOptional<Type.TBoolean>; /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
  threadId: Type.TOptional<Type.TString>;
  channel: Type.TOptional<Type.TString>;
  accountId: Type.TOptional<Type.TString>;
  idempotencyKey: Type.TString;
}>;
declare const AgentParamsSchema: Type.TObject<{
  message: Type.TString;
  agentId: Type.TOptional<Type.TString>;
  provider: Type.TOptional<Type.TString>;
  model: Type.TOptional<Type.TString>;
  to: Type.TOptional<Type.TString>;
  replyTo: Type.TOptional<Type.TString>;
  sessionId: Type.TOptional<Type.TString>;
  sessionKey: Type.TOptional<Type.TString>;
  thinking: Type.TOptional<Type.TString>;
  deliver: Type.TOptional<Type.TBoolean>;
  attachments: Type.TOptional<Type.TArray<Type.TUnknown>>;
  channel: Type.TOptional<Type.TString>;
  replyChannel: Type.TOptional<Type.TString>;
  accountId: Type.TOptional<Type.TString>;
  replyAccountId: Type.TOptional<Type.TString>;
  threadId: Type.TOptional<Type.TString>;
  groupId: Type.TOptional<Type.TString>;
  groupChannel: Type.TOptional<Type.TString>;
  groupSpace: Type.TOptional<Type.TString>;
  timeout: Type.TOptional<Type.TInteger>;
  bestEffortDeliver: Type.TOptional<Type.TBoolean>;
  lane: Type.TOptional<Type.TString>;
  cleanupBundleMcpOnRunEnd: Type.TOptional<Type.TBoolean>;
  modelRun: Type.TOptional<Type.TBoolean>;
  promptMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"full">, Type.TLiteral<"minimal">, Type.TLiteral<"none">]>>;
  extraSystemPrompt: Type.TOptional<Type.TString>;
  bootstrapContextMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"full">, Type.TLiteral<"lightweight">]>>;
  bootstrapContextRunKind: Type.TOptional<Type.TUnion<[Type.TLiteral<"default">, Type.TLiteral<"heartbeat">, Type.TLiteral<"cron">]>>;
  acpTurnSource: Type.TOptional<Type.TLiteral<"manual_spawn">>;
  internalRuntimeHandoffId: Type.TOptional<Type.TString>;
  internalEvents: Type.TOptional<Type.TArray<Type.TObject<{
    type: Type.TLiteral<"task_completion">;
    source: Type.TString;
    childSessionKey: Type.TString;
    childSessionId: Type.TOptional<Type.TString>;
    announceType: Type.TString;
    taskLabel: Type.TString;
    status: Type.TString;
    statusLabel: Type.TString;
    result: Type.TString;
    attachments: Type.TOptional<Type.TArray<Type.TObject<{
      type: Type.TOptional<Type.TString>;
      path: Type.TOptional<Type.TString>;
      url: Type.TOptional<Type.TString>;
      mediaUrl: Type.TOptional<Type.TString>;
      filePath: Type.TOptional<Type.TString>;
      mimeType: Type.TOptional<Type.TString>;
      name: Type.TOptional<Type.TString>;
    }>>>;
    mediaUrls: Type.TOptional<Type.TArray<Type.TString>>;
    statsLine: Type.TOptional<Type.TString>;
    replyInstruction: Type.TString;
  }>>>;
  inputProvenance: Type.TOptional<Type.TObject<{
    kind: Type.TString;
    originSessionId: Type.TOptional<Type.TString>;
    sourceSessionKey: Type.TOptional<Type.TString>;
    sourceChannel: Type.TOptional<Type.TString>;
    sourceTool: Type.TOptional<Type.TString>;
  }>>;
  sourceReplyDeliveryMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"automatic">, Type.TLiteral<"message_tool_only">]>>;
  voiceWakeTrigger: Type.TOptional<Type.TString>;
  idempotencyKey: Type.TString;
  label: Type.TOptional<Type.TString>;
}>;
declare const AgentIdentityParamsSchema: Type.TObject<{
  agentId: Type.TOptional<Type.TString>;
  sessionKey: Type.TOptional<Type.TString>;
}>;
declare const AgentIdentityResultSchema: Type.TObject<{
  agentId: Type.TString;
  name: Type.TOptional<Type.TString>;
  avatar: Type.TOptional<Type.TString>;
  avatarSource: Type.TOptional<Type.TString>;
  avatarStatus: Type.TOptional<Type.TString>;
  avatarReason: Type.TOptional<Type.TString>;
  emoji: Type.TOptional<Type.TString>;
}>;
declare const WakeParamsSchema: Type.TObject<{
  mode: Type.TUnion<[Type.TLiteral<"now">, Type.TLiteral<"next-heartbeat">]>;
  text: Type.TString;
  sessionKey: Type.TOptional<Type.TString>;
}>;
//#endregion
//#region src/gateway/protocol/schema/agents-models-skills.d.ts
declare const AgentSummarySchema: Type.TObject<{
  id: Type.TString;
  name: Type.TOptional<Type.TString>;
  identity: Type.TOptional<Type.TObject<{
    name: Type.TOptional<Type.TString>;
    theme: Type.TOptional<Type.TString>;
    emoji: Type.TOptional<Type.TString>;
    avatar: Type.TOptional<Type.TString>;
    avatarUrl: Type.TOptional<Type.TString>;
  }>>;
  workspace: Type.TOptional<Type.TString>;
  model: Type.TOptional<Type.TObject<{
    primary: Type.TOptional<Type.TString>;
    fallbacks: Type.TOptional<Type.TArray<Type.TString>>;
  }>>;
  agentRuntime: Type.TOptional<Type.TObject<{
    id: Type.TString;
    fallback: Type.TOptional<Type.TUnion<[Type.TLiteral<"pi">, Type.TLiteral<"none">]>>;
    source: Type.TUnion<[Type.TLiteral<"env">, Type.TLiteral<"agent">, Type.TLiteral<"defaults">, Type.TLiteral<"model">, Type.TLiteral<"provider">, Type.TLiteral<"implicit">]>;
  }>>;
}>;
declare const AgentsListParamsSchema: Type.TObject<{}>;
declare const AgentsListResultSchema: Type.TObject<{
  defaultId: Type.TString;
  mainKey: Type.TString;
  scope: Type.TUnion<[Type.TLiteral<"per-sender">, Type.TLiteral<"global">]>;
  agents: Type.TArray<Type.TObject<{
    id: Type.TString;
    name: Type.TOptional<Type.TString>;
    identity: Type.TOptional<Type.TObject<{
      name: Type.TOptional<Type.TString>;
      theme: Type.TOptional<Type.TString>;
      emoji: Type.TOptional<Type.TString>;
      avatar: Type.TOptional<Type.TString>;
      avatarUrl: Type.TOptional<Type.TString>;
    }>>;
    workspace: Type.TOptional<Type.TString>;
    model: Type.TOptional<Type.TObject<{
      primary: Type.TOptional<Type.TString>;
      fallbacks: Type.TOptional<Type.TArray<Type.TString>>;
    }>>;
    agentRuntime: Type.TOptional<Type.TObject<{
      id: Type.TString;
      fallback: Type.TOptional<Type.TUnion<[Type.TLiteral<"pi">, Type.TLiteral<"none">]>>;
      source: Type.TUnion<[Type.TLiteral<"env">, Type.TLiteral<"agent">, Type.TLiteral<"defaults">, Type.TLiteral<"model">, Type.TLiteral<"provider">, Type.TLiteral<"implicit">]>;
    }>>;
  }>>;
}>;
declare const AgentsCreateParamsSchema: Type.TObject<{
  name: Type.TString;
  workspace: Type.TString;
  model: Type.TOptional<Type.TString>;
  emoji: Type.TOptional<Type.TString>;
  avatar: Type.TOptional<Type.TString>;
}>;
declare const AgentsCreateResultSchema: Type.TObject<{
  ok: Type.TLiteral<true>;
  agentId: Type.TString;
  name: Type.TString;
  workspace: Type.TString;
  model: Type.TOptional<Type.TString>;
}>;
declare const AgentsUpdateParamsSchema: Type.TObject<{
  agentId: Type.TString;
  name: Type.TOptional<Type.TString>;
  workspace: Type.TOptional<Type.TString>;
  model: Type.TOptional<Type.TString>;
  emoji: Type.TOptional<Type.TString>;
  avatar: Type.TOptional<Type.TString>;
}>;
declare const AgentsUpdateResultSchema: Type.TObject<{
  ok: Type.TLiteral<true>;
  agentId: Type.TString;
}>;
declare const AgentsDeleteParamsSchema: Type.TObject<{
  agentId: Type.TString;
  deleteFiles: Type.TOptional<Type.TBoolean>;
}>;
declare const AgentsDeleteResultSchema: Type.TObject<{
  ok: Type.TLiteral<true>;
  agentId: Type.TString;
  removedBindings: Type.TInteger;
}>;
declare const AgentsFileEntrySchema: Type.TObject<{
  name: Type.TString;
  path: Type.TString;
  missing: Type.TBoolean;
  size: Type.TOptional<Type.TInteger>;
  updatedAtMs: Type.TOptional<Type.TInteger>;
  content: Type.TOptional<Type.TString>;
}>;
declare const AgentsFilesListParamsSchema: Type.TObject<{
  agentId: Type.TString;
}>;
declare const AgentsFilesListResultSchema: Type.TObject<{
  agentId: Type.TString;
  workspace: Type.TString;
  files: Type.TArray<Type.TObject<{
    name: Type.TString;
    path: Type.TString;
    missing: Type.TBoolean;
    size: Type.TOptional<Type.TInteger>;
    updatedAtMs: Type.TOptional<Type.TInteger>;
    content: Type.TOptional<Type.TString>;
  }>>;
}>;
declare const AgentsFilesGetParamsSchema: Type.TObject<{
  agentId: Type.TString;
  name: Type.TString;
}>;
declare const AgentsFilesGetResultSchema: Type.TObject<{
  agentId: Type.TString;
  workspace: Type.TString;
  file: Type.TObject<{
    name: Type.TString;
    path: Type.TString;
    missing: Type.TBoolean;
    size: Type.TOptional<Type.TInteger>;
    updatedAtMs: Type.TOptional<Type.TInteger>;
    content: Type.TOptional<Type.TString>;
  }>;
}>;
declare const AgentsFilesSetParamsSchema: Type.TObject<{
  agentId: Type.TString;
  name: Type.TString;
  content: Type.TString;
}>;
declare const AgentsFilesSetResultSchema: Type.TObject<{
  ok: Type.TLiteral<true>;
  agentId: Type.TString;
  workspace: Type.TString;
  file: Type.TObject<{
    name: Type.TString;
    path: Type.TString;
    missing: Type.TBoolean;
    size: Type.TOptional<Type.TInteger>;
    updatedAtMs: Type.TOptional<Type.TInteger>;
    content: Type.TOptional<Type.TString>;
  }>;
}>;
declare const ModelsListParamsSchema: Type.TObject<{
  view: Type.TOptional<Type.TUnion<[Type.TLiteral<"default">, Type.TLiteral<"configured">, Type.TLiteral<"all">]>>;
}>;
declare const SkillsStatusParamsSchema: Type.TObject<{
  agentId: Type.TOptional<Type.TString>;
}>;
declare const SkillsUploadBeginParamsSchema: Type.TObject<{
  kind: Type.TLiteral<"skill-archive">;
  slug: Type.TString;
  sizeBytes: Type.TInteger;
  sha256: Type.TOptional<Type.TString>;
  force: Type.TOptional<Type.TBoolean>;
  idempotencyKey: Type.TOptional<Type.TString>;
}>;
declare const SkillsUploadChunkParamsSchema: Type.TObject<{
  uploadId: Type.TString;
  offset: Type.TInteger;
  dataBase64: Type.TString;
}>;
declare const SkillsUploadCommitParamsSchema: Type.TObject<{
  uploadId: Type.TString;
  sha256: Type.TOptional<Type.TString>;
}>;
declare const SkillsInstallParamsSchema: Type.TUnion<[Type.TObject<{
  name: Type.TString;
  installId: Type.TString;
  dangerouslyForceUnsafeInstall: Type.TOptional<Type.TBoolean>;
  timeoutMs: Type.TOptional<Type.TInteger>;
}>, Type.TObject<{
  source: Type.TLiteral<"clawhub">;
  slug: Type.TString;
  version: Type.TOptional<Type.TString>;
  force: Type.TOptional<Type.TBoolean>;
  timeoutMs: Type.TOptional<Type.TInteger>;
}>, Type.TObject<{
  source: Type.TLiteral<"upload">;
  uploadId: Type.TString;
  slug: Type.TString;
  force: Type.TOptional<Type.TBoolean>;
  sha256: Type.TOptional<Type.TString>;
  timeoutMs: Type.TOptional<Type.TInteger>;
}>]>;
declare const SkillsUpdateParamsSchema: Type.TUnion<[Type.TObject<{
  skillKey: Type.TString;
  enabled: Type.TOptional<Type.TBoolean>;
  apiKey: Type.TOptional<Type.TString>;
  env: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
}>, Type.TObject<{
  source: Type.TLiteral<"clawhub">;
  slug: Type.TOptional<Type.TString>;
  all: Type.TOptional<Type.TBoolean>;
}>]>;
declare const SkillsSearchParamsSchema: Type.TObject<{
  query: Type.TOptional<Type.TString>;
  limit: Type.TOptional<Type.TInteger>;
}>;
declare const SkillsSearchResultSchema: Type.TObject<{
  results: Type.TArray<Type.TObject<{
    score: Type.TNumber;
    slug: Type.TString;
    displayName: Type.TString;
    summary: Type.TOptional<Type.TString>;
    version: Type.TOptional<Type.TString>;
    updatedAt: Type.TOptional<Type.TInteger>;
  }>>;
}>;
declare const SkillsDetailParamsSchema: Type.TObject<{
  slug: Type.TString;
}>;
declare const SkillsDetailResultSchema: Type.TObject<{
  skill: Type.TUnion<[Type.TObject<{
    slug: Type.TString;
    displayName: Type.TString;
    summary: Type.TOptional<Type.TString>;
    tags: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
    createdAt: Type.TInteger;
    updatedAt: Type.TInteger;
  }>, Type.TNull]>;
  latestVersion: Type.TOptional<Type.TUnion<[Type.TObject<{
    version: Type.TString;
    createdAt: Type.TInteger;
    changelog: Type.TOptional<Type.TString>;
  }>, Type.TNull]>>;
  metadata: Type.TOptional<Type.TUnion<[Type.TObject<{
    os: Type.TOptional<Type.TUnion<[Type.TArray<Type.TString>, Type.TNull]>>;
    systems: Type.TOptional<Type.TUnion<[Type.TArray<Type.TString>, Type.TNull]>>;
  }>, Type.TNull]>>;
  owner: Type.TOptional<Type.TUnion<[Type.TObject<{
    handle: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    displayName: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    image: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  }>, Type.TNull]>>;
}>;
declare const ToolsCatalogParamsSchema: Type.TObject<{
  agentId: Type.TOptional<Type.TString>;
  includePlugins: Type.TOptional<Type.TBoolean>;
}>;
declare const ToolsEffectiveParamsSchema: Type.TObject<{
  agentId: Type.TOptional<Type.TString>;
  sessionKey: Type.TString;
}>;
declare const ToolsInvokeParamsSchema: Type.TObject<{
  name: Type.TString;
  args: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
  sessionKey: Type.TOptional<Type.TString>;
  agentId: Type.TOptional<Type.TString>;
  confirm: Type.TOptional<Type.TBoolean>;
  idempotencyKey: Type.TOptional<Type.TString>;
}>;
//#endregion
//#region src/gateway/protocol/schema/artifacts.d.ts
declare const ArtifactSummarySchema: Type.TObject<{
  id: Type.TString;
  type: Type.TString;
  title: Type.TString;
  mimeType: Type.TOptional<Type.TString>;
  sizeBytes: Type.TOptional<Type.TInteger>;
  sessionKey: Type.TOptional<Type.TString>;
  runId: Type.TOptional<Type.TString>;
  taskId: Type.TOptional<Type.TString>;
  messageSeq: Type.TOptional<Type.TInteger>;
  source: Type.TOptional<Type.TString>;
  download: Type.TObject<{
    mode: Type.TUnion<[Type.TLiteral<"bytes">, Type.TLiteral<"url">, Type.TLiteral<"unsupported">]>;
  }>;
}>;
declare const ArtifactsListParamsSchema: Type.TObject<{
  sessionKey: Type.TOptional<Type.TString>;
  runId: Type.TOptional<Type.TString>;
  taskId: Type.TOptional<Type.TString>;
  agentId: Type.TOptional<Type.TString>;
}>;
declare const ArtifactsGetParamsSchema: Type.TObject<{
  artifactId: Type.TString;
  sessionKey: Type.TOptional<Type.TString>;
  runId: Type.TOptional<Type.TString>;
  taskId: Type.TOptional<Type.TString>;
  agentId: Type.TOptional<Type.TString>;
}>;
declare const ArtifactsDownloadParamsSchema: Type.TObject<{
  artifactId: Type.TString;
  sessionKey: Type.TOptional<Type.TString>;
  runId: Type.TOptional<Type.TString>;
  taskId: Type.TOptional<Type.TString>;
  agentId: Type.TOptional<Type.TString>;
}>;
//#endregion
//#region src/gateway/protocol/schema/channels.d.ts
declare const TalkConfigParamsSchema: Type.TObject<{
  includeSecrets: Type.TOptional<Type.TBoolean>;
}>;
declare const TalkSpeakParamsSchema: Type.TObject<{
  text: Type.TString;
  voiceId: Type.TOptional<Type.TString>;
  modelId: Type.TOptional<Type.TString>;
  outputFormat: Type.TOptional<Type.TString>;
  speed: Type.TOptional<Type.TNumber>;
  rateWpm: Type.TOptional<Type.TInteger>;
  stability: Type.TOptional<Type.TNumber>;
  similarity: Type.TOptional<Type.TNumber>;
  style: Type.TOptional<Type.TNumber>;
  speakerBoost: Type.TOptional<Type.TBoolean>;
  seed: Type.TOptional<Type.TInteger>;
  normalize: Type.TOptional<Type.TString>;
  language: Type.TOptional<Type.TString>;
  latencyTier: Type.TOptional<Type.TInteger>;
}>;
declare const TalkEventSchema: Type.TObject<{
  id: Type.TString;
  type: Type.TUnion<[Type.TLiteral<"session.started">, Type.TLiteral<"session.ready">, Type.TLiteral<"session.closed">, Type.TLiteral<"session.error">, Type.TLiteral<"session.replaced">, Type.TLiteral<"turn.started">, Type.TLiteral<"turn.ended">, Type.TLiteral<"turn.cancelled">, Type.TLiteral<"capture.started">, Type.TLiteral<"capture.stopped">, Type.TLiteral<"capture.cancelled">, Type.TLiteral<"capture.once">, Type.TLiteral<"input.audio.delta">, Type.TLiteral<"input.audio.committed">, Type.TLiteral<"transcript.delta">, Type.TLiteral<"transcript.done">, Type.TLiteral<"output.text.delta">, Type.TLiteral<"output.text.done">, Type.TLiteral<"output.audio.started">, Type.TLiteral<"output.audio.delta">, Type.TLiteral<"output.audio.done">, Type.TLiteral<"tool.call">, Type.TLiteral<"tool.progress">, Type.TLiteral<"tool.result">, Type.TLiteral<"tool.error">, Type.TLiteral<"usage.metrics">, Type.TLiteral<"latency.metrics">, Type.TLiteral<"health.changed">]>;
  sessionId: Type.TString;
  turnId: Type.TOptional<Type.TString>;
  captureId: Type.TOptional<Type.TString>;
  seq: Type.TInteger;
  timestamp: Type.TString;
  mode: Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>;
  transport: Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>;
  brain: Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>;
  provider: Type.TOptional<Type.TString>;
  final: Type.TOptional<Type.TBoolean>;
  callId: Type.TOptional<Type.TString>;
  itemId: Type.TOptional<Type.TString>;
  parentId: Type.TOptional<Type.TString>;
  payload: Type.TUnknown;
}>;
declare const TalkClientCreateParamsSchema: Type.TObject<{
  sessionKey: Type.TOptional<Type.TString>;
  provider: Type.TOptional<Type.TString>;
  model: Type.TOptional<Type.TString>;
  voice: Type.TOptional<Type.TString>;
  vadThreshold: Type.TOptional<Type.TNumber>;
  silenceDurationMs: Type.TOptional<Type.TInteger>;
  prefixPaddingMs: Type.TOptional<Type.TInteger>;
  reasoningEffort: Type.TOptional<Type.TString>;
  mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>>;
  transport: Type.TOptional<Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>>;
  brain: Type.TOptional<Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>>;
}>;
declare const TalkClientToolCallParamsSchema: Type.TObject<{
  sessionKey: Type.TString;
  callId: Type.TString;
  name: Type.TString;
  args: Type.TOptional<Type.TUnknown>;
  relaySessionId: Type.TOptional<Type.TString>;
}>;
declare const TalkClientToolCallResultSchema: Type.TObject<{
  runId: Type.TString;
  idempotencyKey: Type.TString;
}>;
declare const TalkSessionJoinParamsSchema: Type.TObject<{
  sessionId: Type.TString;
  token: Type.TString;
}>;
declare const TalkSessionCreateParamsSchema: Type.TObject<{
  sessionKey: Type.TOptional<Type.TString>;
  spawnedBy: Type.TOptional<Type.TString>;
  provider: Type.TOptional<Type.TString>;
  model: Type.TOptional<Type.TString>;
  voice: Type.TOptional<Type.TString>;
  vadThreshold: Type.TOptional<Type.TNumber>;
  silenceDurationMs: Type.TOptional<Type.TInteger>;
  prefixPaddingMs: Type.TOptional<Type.TInteger>;
  reasoningEffort: Type.TOptional<Type.TString>;
  mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>>;
  transport: Type.TOptional<Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>>;
  brain: Type.TOptional<Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>>;
  ttlMs: Type.TOptional<Type.TInteger>;
}>;
declare const TalkSessionAppendAudioParamsSchema: Type.TObject<{
  sessionId: Type.TString;
  audioBase64: Type.TString;
  timestamp: Type.TOptional<Type.TNumber>;
}>;
declare const TalkSessionTurnParamsSchema: Type.TObject<{
  sessionId: Type.TString;
  turnId: Type.TOptional<Type.TString>;
}>;
declare const TalkSessionCancelTurnParamsSchema: Type.TObject<{
  sessionId: Type.TString;
  turnId: Type.TOptional<Type.TString>;
  reason: Type.TOptional<Type.TString>;
}>;
declare const TalkSessionCancelOutputParamsSchema: Type.TObject<{
  sessionId: Type.TString;
  turnId: Type.TOptional<Type.TString>;
  reason: Type.TOptional<Type.TString>;
}>;
declare const TalkSessionSubmitToolResultParamsSchema: Type.TObject<{
  sessionId: Type.TString;
  callId: Type.TString;
  result: Type.TUnknown;
  options: Type.TOptional<Type.TObject<{
    suppressResponse: Type.TOptional<Type.TBoolean>;
    willContinue: Type.TOptional<Type.TBoolean>;
  }>>;
}>;
declare const TalkSessionCloseParamsSchema: Type.TObject<{
  sessionId: Type.TString;
}>;
declare const TalkCatalogParamsSchema: Type.TObject<{}>;
declare const TalkCatalogResultSchema: Type.TObject<{
  modes: Type.TArray<Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>>;
  transports: Type.TArray<Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>>;
  brains: Type.TArray<Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>>;
  speech: Type.TObject<{
    activeProvider: Type.TOptional<Type.TString>;
    providers: Type.TArray<Type.TObject<{
      id: Type.TString;
      label: Type.TString;
      configured: Type.TBoolean;
      models: Type.TOptional<Type.TArray<Type.TString>>;
      voices: Type.TOptional<Type.TArray<Type.TString>>;
      defaultModel: Type.TOptional<Type.TString>;
      modes: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>>>;
      transports: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>>>;
      brains: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>>>;
      inputAudioFormats: Type.TOptional<Type.TArray<Type.TObject<{
        encoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
        sampleRateHz: Type.TInteger;
        channels: Type.TInteger;
      }>>>;
      outputAudioFormats: Type.TOptional<Type.TArray<Type.TObject<{
        encoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
        sampleRateHz: Type.TInteger;
        channels: Type.TInteger;
      }>>>;
      supportsBrowserSession: Type.TOptional<Type.TBoolean>;
      supportsBargeIn: Type.TOptional<Type.TBoolean>;
      supportsToolCalls: Type.TOptional<Type.TBoolean>;
      supportsVideoFrames: Type.TOptional<Type.TBoolean>;
      supportsSessionResumption: Type.TOptional<Type.TBoolean>;
    }>>;
  }>;
  transcription: Type.TObject<{
    activeProvider: Type.TOptional<Type.TString>;
    providers: Type.TArray<Type.TObject<{
      id: Type.TString;
      label: Type.TString;
      configured: Type.TBoolean;
      models: Type.TOptional<Type.TArray<Type.TString>>;
      voices: Type.TOptional<Type.TArray<Type.TString>>;
      defaultModel: Type.TOptional<Type.TString>;
      modes: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>>>;
      transports: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>>>;
      brains: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>>>;
      inputAudioFormats: Type.TOptional<Type.TArray<Type.TObject<{
        encoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
        sampleRateHz: Type.TInteger;
        channels: Type.TInteger;
      }>>>;
      outputAudioFormats: Type.TOptional<Type.TArray<Type.TObject<{
        encoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
        sampleRateHz: Type.TInteger;
        channels: Type.TInteger;
      }>>>;
      supportsBrowserSession: Type.TOptional<Type.TBoolean>;
      supportsBargeIn: Type.TOptional<Type.TBoolean>;
      supportsToolCalls: Type.TOptional<Type.TBoolean>;
      supportsVideoFrames: Type.TOptional<Type.TBoolean>;
      supportsSessionResumption: Type.TOptional<Type.TBoolean>;
    }>>;
  }>;
  realtime: Type.TObject<{
    activeProvider: Type.TOptional<Type.TString>;
    providers: Type.TArray<Type.TObject<{
      id: Type.TString;
      label: Type.TString;
      configured: Type.TBoolean;
      models: Type.TOptional<Type.TArray<Type.TString>>;
      voices: Type.TOptional<Type.TArray<Type.TString>>;
      defaultModel: Type.TOptional<Type.TString>;
      modes: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>>>;
      transports: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>>>;
      brains: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>>>;
      inputAudioFormats: Type.TOptional<Type.TArray<Type.TObject<{
        encoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
        sampleRateHz: Type.TInteger;
        channels: Type.TInteger;
      }>>>;
      outputAudioFormats: Type.TOptional<Type.TArray<Type.TObject<{
        encoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
        sampleRateHz: Type.TInteger;
        channels: Type.TInteger;
      }>>>;
      supportsBrowserSession: Type.TOptional<Type.TBoolean>;
      supportsBargeIn: Type.TOptional<Type.TBoolean>;
      supportsToolCalls: Type.TOptional<Type.TBoolean>;
      supportsVideoFrames: Type.TOptional<Type.TBoolean>;
      supportsSessionResumption: Type.TOptional<Type.TBoolean>;
    }>>;
  }>;
}>;
declare const TalkSessionCreateResultSchema: Type.TObject<{
  sessionId: Type.TString;
  provider: Type.TOptional<Type.TString>;
  mode: Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>;
  transport: Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>;
  brain: Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>;
  relaySessionId: Type.TOptional<Type.TString>;
  transcriptionSessionId: Type.TOptional<Type.TString>;
  handoffId: Type.TOptional<Type.TString>;
  roomId: Type.TOptional<Type.TString>;
  roomUrl: Type.TOptional<Type.TString>;
  token: Type.TOptional<Type.TString>;
  audio: Type.TOptional<Type.TUnknown>;
  model: Type.TOptional<Type.TString>;
  voice: Type.TOptional<Type.TString>;
  expiresAt: Type.TOptional<Type.TNumber>;
}>;
declare const TalkSessionTurnResultSchema: Type.TObject<{
  ok: Type.TBoolean;
  turnId: Type.TOptional<Type.TString>;
  events: Type.TOptional<Type.TArray<Type.TObject<{
    id: Type.TString;
    type: Type.TUnion<[Type.TLiteral<"session.started">, Type.TLiteral<"session.ready">, Type.TLiteral<"session.closed">, Type.TLiteral<"session.error">, Type.TLiteral<"session.replaced">, Type.TLiteral<"turn.started">, Type.TLiteral<"turn.ended">, Type.TLiteral<"turn.cancelled">, Type.TLiteral<"capture.started">, Type.TLiteral<"capture.stopped">, Type.TLiteral<"capture.cancelled">, Type.TLiteral<"capture.once">, Type.TLiteral<"input.audio.delta">, Type.TLiteral<"input.audio.committed">, Type.TLiteral<"transcript.delta">, Type.TLiteral<"transcript.done">, Type.TLiteral<"output.text.delta">, Type.TLiteral<"output.text.done">, Type.TLiteral<"output.audio.started">, Type.TLiteral<"output.audio.delta">, Type.TLiteral<"output.audio.done">, Type.TLiteral<"tool.call">, Type.TLiteral<"tool.progress">, Type.TLiteral<"tool.result">, Type.TLiteral<"tool.error">, Type.TLiteral<"usage.metrics">, Type.TLiteral<"latency.metrics">, Type.TLiteral<"health.changed">]>;
    sessionId: Type.TString;
    turnId: Type.TOptional<Type.TString>;
    captureId: Type.TOptional<Type.TString>;
    seq: Type.TInteger;
    timestamp: Type.TString;
    mode: Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>;
    transport: Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>;
    brain: Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>;
    provider: Type.TOptional<Type.TString>;
    final: Type.TOptional<Type.TBoolean>;
    callId: Type.TOptional<Type.TString>;
    itemId: Type.TOptional<Type.TString>;
    parentId: Type.TOptional<Type.TString>;
    payload: Type.TUnknown;
  }>>>;
}>;
declare const TalkSessionJoinResultSchema: Type.TObject<{
  id: Type.TString;
  roomId: Type.TString;
  roomUrl: Type.TString;
  sessionKey: Type.TString;
  sessionId: Type.TOptional<Type.TString>;
  channel: Type.TOptional<Type.TString>;
  target: Type.TOptional<Type.TString>;
  provider: Type.TOptional<Type.TString>;
  model: Type.TOptional<Type.TString>;
  voice: Type.TOptional<Type.TString>;
  mode: Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>;
  transport: Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>;
  brain: Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>;
  createdAt: Type.TNumber;
  expiresAt: Type.TNumber;
  room: Type.TObject<{
    activeClientId: Type.TOptional<Type.TString>;
    activeTurnId: Type.TOptional<Type.TString>;
    recentTalkEvents: Type.TArray<Type.TObject<{
      id: Type.TString;
      type: Type.TUnion<[Type.TLiteral<"session.started">, Type.TLiteral<"session.ready">, Type.TLiteral<"session.closed">, Type.TLiteral<"session.error">, Type.TLiteral<"session.replaced">, Type.TLiteral<"turn.started">, Type.TLiteral<"turn.ended">, Type.TLiteral<"turn.cancelled">, Type.TLiteral<"capture.started">, Type.TLiteral<"capture.stopped">, Type.TLiteral<"capture.cancelled">, Type.TLiteral<"capture.once">, Type.TLiteral<"input.audio.delta">, Type.TLiteral<"input.audio.committed">, Type.TLiteral<"transcript.delta">, Type.TLiteral<"transcript.done">, Type.TLiteral<"output.text.delta">, Type.TLiteral<"output.text.done">, Type.TLiteral<"output.audio.started">, Type.TLiteral<"output.audio.delta">, Type.TLiteral<"output.audio.done">, Type.TLiteral<"tool.call">, Type.TLiteral<"tool.progress">, Type.TLiteral<"tool.result">, Type.TLiteral<"tool.error">, Type.TLiteral<"usage.metrics">, Type.TLiteral<"latency.metrics">, Type.TLiteral<"health.changed">]>;
      sessionId: Type.TString;
      turnId: Type.TOptional<Type.TString>;
      captureId: Type.TOptional<Type.TString>;
      seq: Type.TInteger;
      timestamp: Type.TString;
      mode: Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>;
      transport: Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>;
      brain: Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>;
      provider: Type.TOptional<Type.TString>;
      final: Type.TOptional<Type.TBoolean>;
      callId: Type.TOptional<Type.TString>;
      itemId: Type.TOptional<Type.TString>;
      parentId: Type.TOptional<Type.TString>;
      payload: Type.TUnknown;
    }>>;
  }>;
}>;
declare const TalkSessionOkResultSchema: Type.TObject<{
  ok: Type.TBoolean;
}>;
declare const TalkClientCreateResultSchema: Type.TUnion<[Type.TObject<{
  provider: Type.TString;
  transport: Type.TLiteral<"webrtc">;
  clientSecret: Type.TString;
  offerUrl: Type.TOptional<Type.TString>;
  offerHeaders: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
  model: Type.TOptional<Type.TString>;
  voice: Type.TOptional<Type.TString>;
  expiresAt: Type.TOptional<Type.TNumber>;
}>, Type.TObject<{
  provider: Type.TString;
  transport: Type.TLiteral<"provider-websocket">;
  protocol: Type.TString;
  clientSecret: Type.TString;
  websocketUrl: Type.TString;
  audio: Type.TObject<{
    inputEncoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
    inputSampleRateHz: Type.TInteger;
    outputEncoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
    outputSampleRateHz: Type.TInteger;
  }>;
  initialMessage: Type.TOptional<Type.TUnknown>;
  model: Type.TOptional<Type.TString>;
  voice: Type.TOptional<Type.TString>;
  expiresAt: Type.TOptional<Type.TNumber>;
}>, Type.TObject<{
  provider: Type.TString;
  transport: Type.TLiteral<"gateway-relay">;
  relaySessionId: Type.TString;
  audio: Type.TObject<{
    inputEncoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
    inputSampleRateHz: Type.TInteger;
    outputEncoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
    outputSampleRateHz: Type.TInteger;
  }>;
  model: Type.TOptional<Type.TString>;
  voice: Type.TOptional<Type.TString>;
  expiresAt: Type.TOptional<Type.TNumber>;
}>, Type.TObject<{
  provider: Type.TString;
  transport: Type.TLiteral<"managed-room">;
  roomUrl: Type.TString;
  token: Type.TOptional<Type.TString>;
  model: Type.TOptional<Type.TString>;
  voice: Type.TOptional<Type.TString>;
  expiresAt: Type.TOptional<Type.TNumber>;
}>]>;
declare const TalkConfigResultSchema: Type.TObject<{
  config: Type.TObject<{
    talk: Type.TOptional<Type.TObject<{
      provider: Type.TOptional<Type.TString>;
      providers: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
        apiKey: Type.TOptional<Type.TUnion<[Type.TString, Type.TUnion<[Type.TObject<{
          source: Type.TLiteral<"env">;
          provider: Type.TString;
          id: Type.TString;
        }>, Type.TObject<{
          source: Type.TLiteral<"file">;
          provider: Type.TString;
          id: Type.TUnsafe<string>;
        }>, Type.TObject<{
          source: Type.TLiteral<"exec">;
          provider: Type.TString;
          id: Type.TString;
        }>]>]>>;
      }>>>;
      realtime: Type.TOptional<Type.TObject<{
        provider: Type.TOptional<Type.TString>;
        providers: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
          apiKey: Type.TOptional<Type.TUnion<[Type.TString, Type.TUnion<[Type.TObject<{
            source: Type.TLiteral<"env">;
            provider: Type.TString;
            id: Type.TString;
          }>, Type.TObject<{
            source: Type.TLiteral<"file">;
            provider: Type.TString;
            id: Type.TUnsafe<string>;
          }>, Type.TObject<{
            source: Type.TLiteral<"exec">;
            provider: Type.TString;
            id: Type.TString;
          }>]>]>>;
        }>>>;
        model: Type.TOptional<Type.TString>;
        voice: Type.TOptional<Type.TString>;
        instructions: Type.TOptional<Type.TString>;
        mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"realtime">, Type.TLiteral<"stt-tts">, Type.TLiteral<"transcription">]>>;
        transport: Type.TOptional<Type.TUnion<[Type.TLiteral<"webrtc">, Type.TLiteral<"provider-websocket">, Type.TLiteral<"gateway-relay">, Type.TLiteral<"managed-room">]>>;
        brain: Type.TOptional<Type.TUnion<[Type.TLiteral<"agent-consult">, Type.TLiteral<"direct-tools">, Type.TLiteral<"none">]>>;
      }>>;
      resolved: Type.TOptional<Type.TObject<{
        provider: Type.TString;
        config: Type.TObject<{
          apiKey: Type.TOptional<Type.TUnion<[Type.TString, Type.TUnion<[Type.TObject<{
            source: Type.TLiteral<"env">;
            provider: Type.TString;
            id: Type.TString;
          }>, Type.TObject<{
            source: Type.TLiteral<"file">;
            provider: Type.TString;
            id: Type.TUnsafe<string>;
          }>, Type.TObject<{
            source: Type.TLiteral<"exec">;
            provider: Type.TString;
            id: Type.TString;
          }>]>]>>;
        }>;
      }>>;
      consultThinkingLevel: Type.TOptional<Type.TString>;
      consultFastMode: Type.TOptional<Type.TBoolean>;
      speechLocale: Type.TOptional<Type.TString>;
      interruptOnSpeech: Type.TOptional<Type.TBoolean>;
      silenceTimeoutMs: Type.TOptional<Type.TInteger>;
    }>>;
    session: Type.TOptional<Type.TObject<{
      mainKey: Type.TOptional<Type.TString>;
    }>>;
    ui: Type.TOptional<Type.TObject<{
      seamColor: Type.TOptional<Type.TString>;
    }>>;
  }>;
}>;
declare const TalkSpeakResultSchema: Type.TObject<{
  audioBase64: Type.TString;
  provider: Type.TString;
  outputFormat: Type.TOptional<Type.TString>;
  voiceCompatible: Type.TOptional<Type.TBoolean>;
  mimeType: Type.TOptional<Type.TString>;
  fileExtension: Type.TOptional<Type.TString>;
}>;
declare const ChannelsStatusParamsSchema: Type.TObject<{
  probe: Type.TOptional<Type.TBoolean>;
  timeoutMs: Type.TOptional<Type.TInteger>;
  channel: Type.TOptional<Type.TString>;
}>;
declare const ChannelsStatusResultSchema: Type.TObject<{
  ts: Type.TInteger;
  channelOrder: Type.TArray<Type.TString>;
  channelLabels: Type.TRecord<"^.*$", Type.TString>;
  channelDetailLabels: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
  channelSystemImages: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
  channelMeta: Type.TOptional<Type.TArray<Type.TObject<{
    id: Type.TString;
    label: Type.TString;
    detailLabel: Type.TString;
    systemImage: Type.TOptional<Type.TString>;
  }>>>;
  channels: Type.TRecord<"^.*$", Type.TUnknown>;
  channelAccounts: Type.TRecord<"^.*$", Type.TArray<Type.TObject<{
    accountId: Type.TString;
    name: Type.TOptional<Type.TString>;
    enabled: Type.TOptional<Type.TBoolean>;
    configured: Type.TOptional<Type.TBoolean>;
    linked: Type.TOptional<Type.TBoolean>;
    running: Type.TOptional<Type.TBoolean>;
    connected: Type.TOptional<Type.TBoolean>;
    reconnectAttempts: Type.TOptional<Type.TInteger>;
    lastConnectedAt: Type.TOptional<Type.TInteger>;
    lastError: Type.TOptional<Type.TString>;
    healthState: Type.TOptional<Type.TString>;
    lastStartAt: Type.TOptional<Type.TInteger>;
    lastStopAt: Type.TOptional<Type.TInteger>;
    lastInboundAt: Type.TOptional<Type.TInteger>;
    lastOutboundAt: Type.TOptional<Type.TInteger>;
    lastTransportActivityAt: Type.TOptional<Type.TInteger>;
    busy: Type.TOptional<Type.TBoolean>;
    activeRuns: Type.TOptional<Type.TInteger>;
    lastRunActivityAt: Type.TOptional<Type.TInteger>;
    lastProbeAt: Type.TOptional<Type.TInteger>;
    mode: Type.TOptional<Type.TString>;
    dmPolicy: Type.TOptional<Type.TString>;
    allowFrom: Type.TOptional<Type.TArray<Type.TString>>;
    tokenSource: Type.TOptional<Type.TString>;
    botTokenSource: Type.TOptional<Type.TString>;
    appTokenSource: Type.TOptional<Type.TString>;
    baseUrl: Type.TOptional<Type.TString>;
    allowUnmentionedGroups: Type.TOptional<Type.TBoolean>;
    cliPath: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    dbPath: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    port: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
    probe: Type.TOptional<Type.TUnknown>;
    audit: Type.TOptional<Type.TUnknown>;
    application: Type.TOptional<Type.TUnknown>;
  }>>>;
  channelDefaultAccountId: Type.TRecord<"^.*$", Type.TString>;
  eventLoop: Type.TOptional<Type.TObject<{
    degraded: Type.TBoolean;
    reasons: Type.TArray<Type.TUnion<[Type.TLiteral<"event_loop_delay">, Type.TLiteral<"event_loop_utilization">, Type.TLiteral<"cpu">]>>;
    intervalMs: Type.TInteger;
    delayP99Ms: Type.TNumber;
    delayMaxMs: Type.TNumber;
    utilization: Type.TNumber;
    cpuCoreRatio: Type.TNumber;
  }>>;
  partial: Type.TOptional<Type.TBoolean>;
  warnings: Type.TOptional<Type.TArray<Type.TString>>;
}>;
declare const ChannelsLogoutParamsSchema: Type.TObject<{
  channel: Type.TString;
  accountId: Type.TOptional<Type.TString>;
}>;
declare const ChannelsStopParamsSchema: Type.TObject<{
  channel: Type.TString;
  accountId: Type.TOptional<Type.TString>;
}>;
declare const ChannelsStartParamsSchema: Type.TObject<{
  channel: Type.TString;
  accountId: Type.TOptional<Type.TString>;
}>;
declare const WebLoginStartParamsSchema: Type.TObject<{
  force: Type.TOptional<Type.TBoolean>;
  timeoutMs: Type.TOptional<Type.TInteger>;
  verbose: Type.TOptional<Type.TBoolean>;
  accountId: Type.TOptional<Type.TString>;
}>;
declare const WebLoginWaitParamsSchema: Type.TObject<{
  timeoutMs: Type.TOptional<Type.TInteger>;
  accountId: Type.TOptional<Type.TString>;
  currentQrDataUrl: Type.TOptional<Type.TString>;
}>;
//#endregion
//#region src/gateway/protocol/schema/commands.d.ts
declare const CommandsListParamsSchema: Type.TObject<{
  agentId: Type.TOptional<Type.TString>;
  provider: Type.TOptional<Type.TString>;
  scope: Type.TOptional<Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"native">, Type.TLiteral<"both">]>>;
  includeArgs: Type.TOptional<Type.TBoolean>;
}>;
declare const CommandsListResultSchema: Type.TObject<{
  commands: Type.TArray<Type.TObject<{
    name: Type.TString;
    nativeName: Type.TOptional<Type.TString>;
    textAliases: Type.TOptional<Type.TArray<Type.TString>>;
    description: Type.TString;
    category: Type.TOptional<Type.TUnion<[Type.TLiteral<"session">, Type.TLiteral<"options">, Type.TLiteral<"status">, Type.TLiteral<"management">, Type.TLiteral<"media">, Type.TLiteral<"tools">, Type.TLiteral<"docks">]>>;
    source: Type.TUnion<[Type.TLiteral<"native">, Type.TLiteral<"skill">, Type.TLiteral<"plugin">]>;
    scope: Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"native">, Type.TLiteral<"both">]>;
    acceptsArgs: Type.TBoolean;
    args: Type.TOptional<Type.TArray<Type.TObject<{
      name: Type.TString;
      description: Type.TString;
      type: Type.TUnion<[Type.TLiteral<"string">, Type.TLiteral<"number">, Type.TLiteral<"boolean">]>;
      required: Type.TOptional<Type.TBoolean>;
      choices: Type.TOptional<Type.TArray<Type.TObject<{
        value: Type.TString;
        label: Type.TString;
      }>>>;
      dynamic: Type.TOptional<Type.TBoolean>;
    }>>>;
  }>>;
}>;
//#endregion
//#region src/gateway/protocol/schema/config.d.ts
declare const ConfigGetParamsSchema: Type.TObject<{}>;
declare const ConfigSetParamsSchema: Type.TObject<{
  raw: Type.TString;
  baseHash: Type.TOptional<Type.TString>;
}>;
declare const ConfigApplyParamsSchema: Type.TObject<{
  raw: Type.TString;
  baseHash: Type.TOptional<Type.TString>;
  sessionKey: Type.TOptional<Type.TString>;
  deliveryContext: Type.TOptional<Type.TObject<{
    channel: Type.TOptional<Type.TString>;
    to: Type.TOptional<Type.TString>;
    accountId: Type.TOptional<Type.TString>;
    threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
  }>>;
  note: Type.TOptional<Type.TString>;
  restartDelayMs: Type.TOptional<Type.TInteger>;
}>;
declare const ConfigPatchParamsSchema: Type.TObject<{
  raw: Type.TString;
  baseHash: Type.TOptional<Type.TString>;
  sessionKey: Type.TOptional<Type.TString>;
  deliveryContext: Type.TOptional<Type.TObject<{
    channel: Type.TOptional<Type.TString>;
    to: Type.TOptional<Type.TString>;
    accountId: Type.TOptional<Type.TString>;
    threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
  }>>;
  note: Type.TOptional<Type.TString>;
  restartDelayMs: Type.TOptional<Type.TInteger>;
}>;
declare const ConfigSchemaParamsSchema: Type.TObject<{}>;
declare const ConfigSchemaLookupParamsSchema: Type.TObject<{
  path: Type.TString;
}>;
declare const UpdateStatusParamsSchema: Type.TObject<{}>;
declare const UpdateRunParamsSchema: Type.TObject<{
  sessionKey: Type.TOptional<Type.TString>;
  deliveryContext: Type.TOptional<Type.TObject<{
    channel: Type.TOptional<Type.TString>;
    to: Type.TOptional<Type.TString>;
    accountId: Type.TOptional<Type.TString>;
    threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
  }>>;
  note: Type.TOptional<Type.TString>;
  continuationMessage: Type.TOptional<Type.TString>;
  restartDelayMs: Type.TOptional<Type.TInteger>;
  timeoutMs: Type.TOptional<Type.TInteger>;
}>;
declare const ConfigSchemaResponseSchema: Type.TObject<{
  schema: Type.TUnknown;
  uiHints: Type.TRecord<"^.*$", Type.TObject<{
    label: Type.TOptional<Type.TString>;
    help: Type.TOptional<Type.TString>;
    tags: Type.TOptional<Type.TArray<Type.TString>>;
    group: Type.TOptional<Type.TString>;
    order: Type.TOptional<Type.TInteger>;
    advanced: Type.TOptional<Type.TBoolean>;
    sensitive: Type.TOptional<Type.TBoolean>;
    placeholder: Type.TOptional<Type.TString>;
    itemTemplate: Type.TOptional<Type.TUnknown>;
  }>>;
  version: Type.TString;
  generatedAt: Type.TString;
}>;
declare const ConfigSchemaLookupResultSchema: Type.TObject<{
  path: Type.TString;
  schema: Type.TUnknown;
  reloadKind: Type.TOptional<Type.TUnion<[Type.TLiteral<"restart">, Type.TLiteral<"hot">, Type.TLiteral<"none">]>>;
  hint: Type.TOptional<Type.TObject<{
    label: Type.TOptional<Type.TString>;
    help: Type.TOptional<Type.TString>;
    tags: Type.TOptional<Type.TArray<Type.TString>>;
    group: Type.TOptional<Type.TString>;
    order: Type.TOptional<Type.TInteger>;
    advanced: Type.TOptional<Type.TBoolean>;
    sensitive: Type.TOptional<Type.TBoolean>;
    placeholder: Type.TOptional<Type.TString>;
    itemTemplate: Type.TOptional<Type.TUnknown>;
  }>>;
  hintPath: Type.TOptional<Type.TString>;
  children: Type.TArray<Type.TObject<{
    key: Type.TString;
    path: Type.TString;
    type: Type.TOptional<Type.TUnion<[Type.TString, Type.TArray<Type.TString>]>>;
    required: Type.TBoolean;
    hasChildren: Type.TBoolean;
    reloadKind: Type.TOptional<Type.TUnion<[Type.TLiteral<"restart">, Type.TLiteral<"hot">, Type.TLiteral<"none">]>>;
    hint: Type.TOptional<Type.TObject<{
      label: Type.TOptional<Type.TString>;
      help: Type.TOptional<Type.TString>;
      tags: Type.TOptional<Type.TArray<Type.TString>>;
      group: Type.TOptional<Type.TString>;
      order: Type.TOptional<Type.TInteger>;
      advanced: Type.TOptional<Type.TBoolean>;
      sensitive: Type.TOptional<Type.TBoolean>;
      placeholder: Type.TOptional<Type.TString>;
      itemTemplate: Type.TOptional<Type.TUnknown>;
    }>>;
    hintPath: Type.TOptional<Type.TString>;
  }>>;
}>;
//#endregion
//#region src/gateway/protocol/schema/cron.d.ts
declare const CronJobSchema: Type.TObject<{
  id: Type.TString;
  agentId: Type.TOptional<Type.TString>;
  sessionKey: Type.TOptional<Type.TString>;
  name: Type.TString;
  description: Type.TOptional<Type.TString>;
  enabled: Type.TBoolean;
  deleteAfterRun: Type.TOptional<Type.TBoolean>;
  createdAtMs: Type.TInteger;
  updatedAtMs: Type.TInteger;
  schedule: Type.TUnion<[Type.TObject<{
    kind: Type.TLiteral<"at">;
    at: Type.TString;
  }>, Type.TObject<{
    kind: Type.TLiteral<"every">;
    everyMs: Type.TInteger;
    anchorMs: Type.TOptional<Type.TInteger>;
  }>, Type.TObject<{
    kind: Type.TLiteral<"cron">;
    expr: Type.TString;
    tz: Type.TOptional<Type.TString>;
    staggerMs: Type.TOptional<Type.TInteger>;
  }>]>;
  sessionTarget: Type.TUnion<[Type.TLiteral<"main">, Type.TLiteral<"isolated">, Type.TLiteral<"current">, Type.TString]>;
  wakeMode: Type.TUnion<[Type.TLiteral<"next-heartbeat">, Type.TLiteral<"now">]>;
  payload: Type.TUnion<[Type.TObject<{
    kind: Type.TLiteral<"systemEvent">;
    text: Type.TString;
  }>, Type.TObject<{
    kind: Type.TLiteral<"agentTurn">;
    message: Type.TSchema;
    model: Type.TOptional<Type.TString>;
    fallbacks: Type.TOptional<Type.TArray<Type.TString>>;
    thinking: Type.TOptional<Type.TString>;
    timeoutSeconds: Type.TOptional<Type.TNumber>;
    allowUnsafeExternalContent: Type.TOptional<Type.TBoolean>;
    lightContext: Type.TOptional<Type.TBoolean>;
    toolsAllow: Type.TOptional<Type.TSchema>;
  }>]>;
  delivery: Type.TOptional<Type.TUnion<[Type.TObject<{
    to: Type.TOptional<Type.TString>;
    channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
    threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    accountId: Type.TOptional<Type.TString>;
    bestEffort: Type.TOptional<Type.TBoolean>;
    failureDestination: Type.TOptional<Type.TObject<{
      channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
      to: Type.TOptional<Type.TString>;
      accountId: Type.TOptional<Type.TString>;
      mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"announce">, Type.TLiteral<"webhook">]>>;
    }>>;
    mode: Type.TLiteral<"none">;
  }>, Type.TObject<{
    to: Type.TOptional<Type.TString>;
    channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
    threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    accountId: Type.TOptional<Type.TString>;
    bestEffort: Type.TOptional<Type.TBoolean>;
    failureDestination: Type.TOptional<Type.TObject<{
      channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
      to: Type.TOptional<Type.TString>;
      accountId: Type.TOptional<Type.TString>;
      mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"announce">, Type.TLiteral<"webhook">]>>;
    }>>;
    mode: Type.TLiteral<"announce">;
  }>, Type.TObject<{
    to: Type.TString;
    channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
    threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    accountId: Type.TOptional<Type.TString>;
    bestEffort: Type.TOptional<Type.TBoolean>;
    failureDestination: Type.TOptional<Type.TObject<{
      channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
      to: Type.TOptional<Type.TString>;
      accountId: Type.TOptional<Type.TString>;
      mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"announce">, Type.TLiteral<"webhook">]>>;
    }>>;
    mode: Type.TLiteral<"webhook">;
  }>]>>;
  failureAlert: Type.TOptional<Type.TUnion<[Type.TLiteral<false>, Type.TObject<{
    after: Type.TOptional<Type.TInteger>;
    channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
    to: Type.TOptional<Type.TString>;
    cooldownMs: Type.TOptional<Type.TInteger>;
    includeSkipped: Type.TOptional<Type.TBoolean>;
    mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"announce">, Type.TLiteral<"webhook">]>>;
    accountId: Type.TOptional<Type.TString>;
  }>]>>;
  state: Type.TObject<{
    nextRunAtMs: Type.TOptional<Type.TInteger>;
    runningAtMs: Type.TOptional<Type.TInteger>;
    lastRunAtMs: Type.TOptional<Type.TInteger>;
    lastRunStatus: Type.TOptional<Type.TUnion<[Type.TLiteral<"ok">, Type.TLiteral<"error">, Type.TLiteral<"skipped">]>>;
    lastStatus: Type.TOptional<Type.TUnion<[Type.TLiteral<"ok">, Type.TLiteral<"error">, Type.TLiteral<"skipped">]>>;
    lastError: Type.TOptional<Type.TString>;
    lastDiagnostics: Type.TOptional<Type.TObject<{
      summary: Type.TOptional<Type.TString>;
      entries: Type.TArray<Type.TObject<{
        ts: Type.TInteger;
        source: Type.TUnion<[Type.TLiteral<"cron-preflight">, Type.TLiteral<"cron-setup">, Type.TLiteral<"model-preflight">, Type.TLiteral<"agent-run">, Type.TLiteral<"tool">, Type.TLiteral<"exec">, Type.TLiteral<"delivery">]>;
        severity: Type.TUnion<[Type.TLiteral<"info">, Type.TLiteral<"warn">, Type.TLiteral<"error">]>;
        message: Type.TString;
        toolName: Type.TOptional<Type.TString>;
        exitCode: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TNull]>>;
        truncated: Type.TOptional<Type.TBoolean>;
      }>>;
    }>>;
    lastDiagnosticSummary: Type.TOptional<Type.TString>;
    lastErrorReason: Type.TOptional<Type.TUnion<[Type.TLiteral<"auth">, Type.TLiteral<"format">, Type.TLiteral<"rate_limit">, Type.TLiteral<"billing">, Type.TLiteral<"server_error">, Type.TLiteral<"timeout">, Type.TLiteral<"model_not_found">, Type.TLiteral<"empty_response">, Type.TLiteral<"no_error_details">, Type.TLiteral<"unclassified">, Type.TLiteral<"unknown">]>>;
    lastDurationMs: Type.TOptional<Type.TInteger>;
    consecutiveErrors: Type.TOptional<Type.TInteger>;
    consecutiveSkipped: Type.TOptional<Type.TInteger>;
    lastDelivered: Type.TOptional<Type.TBoolean>;
    lastDeliveryStatus: Type.TOptional<Type.TUnion<[Type.TLiteral<"delivered">, Type.TLiteral<"not-delivered">, Type.TLiteral<"unknown">, Type.TLiteral<"not-requested">]>>;
    lastDeliveryError: Type.TOptional<Type.TString>;
    lastFailureNotificationDelivered: Type.TOptional<Type.TBoolean>;
    lastFailureNotificationDeliveryStatus: Type.TOptional<Type.TUnion<[Type.TLiteral<"delivered">, Type.TLiteral<"not-delivered">, Type.TLiteral<"unknown">, Type.TLiteral<"not-requested">]>>;
    lastFailureNotificationDeliveryError: Type.TOptional<Type.TString>;
    lastFailureAlertAtMs: Type.TOptional<Type.TInteger>;
  }>;
}>;
declare const CronListParamsSchema: Type.TObject<{
  includeDisabled: Type.TOptional<Type.TBoolean>;
  limit: Type.TOptional<Type.TInteger>;
  offset: Type.TOptional<Type.TInteger>;
  query: Type.TOptional<Type.TString>;
  enabled: Type.TOptional<Type.TUnion<[Type.TLiteral<"all">, Type.TLiteral<"enabled">, Type.TLiteral<"disabled">]>>;
  sortBy: Type.TOptional<Type.TUnion<[Type.TLiteral<"nextRunAtMs">, Type.TLiteral<"updatedAtMs">, Type.TLiteral<"name">]>>;
  sortDir: Type.TOptional<Type.TUnion<[Type.TLiteral<"asc">, Type.TLiteral<"desc">]>>;
  agentId: Type.TOptional<Type.TString>;
}>;
declare const CronStatusParamsSchema: Type.TObject<{}>;
declare const CronGetParamsSchema: Type.TUnion<[Type.TObject<{
  id: Type.TString;
}>, Type.TObject<{
  jobId: Type.TString;
}>]>;
declare const CronAddParamsSchema: Type.TObject<{
  schedule: Type.TUnion<[Type.TObject<{
    kind: Type.TLiteral<"at">;
    at: Type.TString;
  }>, Type.TObject<{
    kind: Type.TLiteral<"every">;
    everyMs: Type.TInteger;
    anchorMs: Type.TOptional<Type.TInteger>;
  }>, Type.TObject<{
    kind: Type.TLiteral<"cron">;
    expr: Type.TString;
    tz: Type.TOptional<Type.TString>;
    staggerMs: Type.TOptional<Type.TInteger>;
  }>]>;
  sessionTarget: Type.TUnion<[Type.TLiteral<"main">, Type.TLiteral<"isolated">, Type.TLiteral<"current">, Type.TString]>;
  wakeMode: Type.TUnion<[Type.TLiteral<"next-heartbeat">, Type.TLiteral<"now">]>;
  payload: Type.TUnion<[Type.TObject<{
    kind: Type.TLiteral<"systemEvent">;
    text: Type.TString;
  }>, Type.TObject<{
    kind: Type.TLiteral<"agentTurn">;
    message: Type.TSchema;
    model: Type.TOptional<Type.TString>;
    fallbacks: Type.TOptional<Type.TArray<Type.TString>>;
    thinking: Type.TOptional<Type.TString>;
    timeoutSeconds: Type.TOptional<Type.TNumber>;
    allowUnsafeExternalContent: Type.TOptional<Type.TBoolean>;
    lightContext: Type.TOptional<Type.TBoolean>;
    toolsAllow: Type.TOptional<Type.TSchema>;
  }>]>;
  delivery: Type.TOptional<Type.TUnion<[Type.TObject<{
    to: Type.TOptional<Type.TString>;
    channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
    threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    accountId: Type.TOptional<Type.TString>;
    bestEffort: Type.TOptional<Type.TBoolean>;
    failureDestination: Type.TOptional<Type.TObject<{
      channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
      to: Type.TOptional<Type.TString>;
      accountId: Type.TOptional<Type.TString>;
      mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"announce">, Type.TLiteral<"webhook">]>>;
    }>>;
    mode: Type.TLiteral<"none">;
  }>, Type.TObject<{
    to: Type.TOptional<Type.TString>;
    channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
    threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    accountId: Type.TOptional<Type.TString>;
    bestEffort: Type.TOptional<Type.TBoolean>;
    failureDestination: Type.TOptional<Type.TObject<{
      channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
      to: Type.TOptional<Type.TString>;
      accountId: Type.TOptional<Type.TString>;
      mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"announce">, Type.TLiteral<"webhook">]>>;
    }>>;
    mode: Type.TLiteral<"announce">;
  }>, Type.TObject<{
    to: Type.TString;
    channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
    threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    accountId: Type.TOptional<Type.TString>;
    bestEffort: Type.TOptional<Type.TBoolean>;
    failureDestination: Type.TOptional<Type.TObject<{
      channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
      to: Type.TOptional<Type.TString>;
      accountId: Type.TOptional<Type.TString>;
      mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"announce">, Type.TLiteral<"webhook">]>>;
    }>>;
    mode: Type.TLiteral<"webhook">;
  }>]>>;
  failureAlert: Type.TOptional<Type.TUnion<[Type.TLiteral<false>, Type.TObject<{
    after: Type.TOptional<Type.TInteger>;
    channel: Type.TOptional<Type.TUnion<[Type.TLiteral<"last">, Type.TString]>>;
    to: Type.TOptional<Type.TString>;
    cooldownMs: Type.TOptional<Type.TInteger>;
    includeSkipped: Type.TOptional<Type.TBoolean>;
    mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"announce">, Type.TLiteral<"webhook">]>>;
    accountId: Type.TOptional<Type.TString>;
  }>]>>;
  agentId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  sessionKey: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  description: Type.TOptional<Type.TString>;
  enabled: Type.TOptional<Type.TBoolean>;
  deleteAfterRun: Type.TOptional<Type.TBoolean>;
  name: Type.TString;
}>;
declare const CronUpdateParamsSchema: Type.TUnion<[Type.TObject<{
  id: Type.TString;
}>, Type.TObject<{
  jobId: Type.TString;
}>]>;
declare const CronRemoveParamsSchema: Type.TUnion<[Type.TObject<{
  id: Type.TString;
}>, Type.TObject<{
  jobId: Type.TString;
}>]>;
declare const CronRunParamsSchema: Type.TUnion<[Type.TObject<{
  id: Type.TString;
}>, Type.TObject<{
  jobId: Type.TString;
}>]>;
declare const CronRunsParamsSchema: Type.TObject<{
  scope: Type.TOptional<Type.TUnion<[Type.TLiteral<"job">, Type.TLiteral<"all">]>>;
  id: Type.TOptional<Type.TString>;
  jobId: Type.TOptional<Type.TString>;
  runId: Type.TOptional<Type.TString>;
  limit: Type.TOptional<Type.TInteger>;
  offset: Type.TOptional<Type.TInteger>;
  statuses: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"ok">, Type.TLiteral<"error">, Type.TLiteral<"skipped">]>>>;
  status: Type.TOptional<Type.TUnion<[Type.TLiteral<"all">, Type.TLiteral<"ok">, Type.TLiteral<"error">, Type.TLiteral<"skipped">]>>;
  deliveryStatuses: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"delivered">, Type.TLiteral<"not-delivered">, Type.TLiteral<"unknown">, Type.TLiteral<"not-requested">]>>>;
  deliveryStatus: Type.TOptional<Type.TUnion<[Type.TLiteral<"delivered">, Type.TLiteral<"not-delivered">, Type.TLiteral<"unknown">, Type.TLiteral<"not-requested">]>>;
  query: Type.TOptional<Type.TString>;
  sortDir: Type.TOptional<Type.TUnion<[Type.TLiteral<"asc">, Type.TLiteral<"desc">]>>;
}>;
//#endregion
//#region src/gateway/protocol/schema/error-codes.d.ts
declare const ErrorCodes: {
  readonly NOT_LINKED: "NOT_LINKED";
  readonly NOT_PAIRED: "NOT_PAIRED";
  readonly AGENT_TIMEOUT: "AGENT_TIMEOUT";
  readonly INVALID_REQUEST: "INVALID_REQUEST";
  readonly APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND";
  readonly UNAVAILABLE: "UNAVAILABLE";
};
type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
declare function errorShape(code: ErrorCode, message: string, opts?: {
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}): ErrorShape;
//#endregion
//#region src/gateway/protocol/schema/environments.d.ts
declare const EnvironmentStatusSchema: Type.TString;
declare const EnvironmentSummarySchema: Type.TObject<{
  id: Type.TString;
  type: Type.TString;
  label: Type.TOptional<Type.TString>;
  status: Type.TString;
  capabilities: Type.TOptional<Type.TArray<Type.TString>>;
}>;
declare const EnvironmentsListParamsSchema: Type.TObject<{}>;
declare const EnvironmentsListResultSchema: Type.TObject<{
  environments: Type.TArray<Type.TObject<{
    id: Type.TString;
    type: Type.TString;
    label: Type.TOptional<Type.TString>;
    status: Type.TString;
    capabilities: Type.TOptional<Type.TArray<Type.TString>>;
  }>>;
}>;
declare const EnvironmentsStatusParamsSchema: Type.TObject<{
  environmentId: Type.TString;
}>;
declare const EnvironmentsStatusResultSchema: Type.TObject<{
  id: Type.TString;
  type: Type.TString;
  label: Type.TOptional<Type.TString>;
  status: Type.TString;
  capabilities: Type.TOptional<Type.TArray<Type.TString>>;
}>;
//#endregion
//#region src/gateway/protocol/schema/exec-approvals.d.ts
declare const ExecApprovalsGetParamsSchema: Type.TObject<{}>;
declare const ExecApprovalsSetParamsSchema: Type.TObject<{
  file: Type.TObject<{
    version: Type.TLiteral<1>;
    socket: Type.TOptional<Type.TObject<{
      path: Type.TOptional<Type.TString>;
      token: Type.TOptional<Type.TString>;
    }>>;
    defaults: Type.TOptional<Type.TObject<{
      security: Type.TOptional<Type.TString>;
      ask: Type.TOptional<Type.TString>;
      askFallback: Type.TOptional<Type.TString>;
      autoAllowSkills: Type.TOptional<Type.TBoolean>;
    }>>;
    agents: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
      allowlist: Type.TOptional<Type.TArray<Type.TObject<{
        id: Type.TOptional<Type.TString>;
        pattern: Type.TString;
        source: Type.TOptional<Type.TLiteral<"allow-always">>;
        commandText: Type.TOptional<Type.TString>;
        argPattern: Type.TOptional<Type.TString>;
        lastUsedAt: Type.TOptional<Type.TInteger>;
        lastUsedCommand: Type.TOptional<Type.TString>;
        lastResolvedPath: Type.TOptional<Type.TString>;
      }>>>;
      security: Type.TOptional<Type.TString>;
      ask: Type.TOptional<Type.TString>;
      askFallback: Type.TOptional<Type.TString>;
      autoAllowSkills: Type.TOptional<Type.TBoolean>;
    }>>>;
  }>;
  baseHash: Type.TOptional<Type.TString>;
}>;
declare const ExecApprovalGetParamsSchema: Type.TObject<{
  id: Type.TString;
}>;
declare const ExecApprovalRequestParamsSchema: Type.TObject<{
  id: Type.TOptional<Type.TString>;
  command: Type.TOptional<Type.TString>;
  commandArgv: Type.TOptional<Type.TArray<Type.TString>>;
  systemRunPlan: Type.TOptional<Type.TObject<{
    argv: Type.TArray<Type.TString>;
    cwd: Type.TUnion<[Type.TString, Type.TNull]>;
    commandText: Type.TString;
    commandPreview: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    agentId: Type.TUnion<[Type.TString, Type.TNull]>;
    sessionKey: Type.TUnion<[Type.TString, Type.TNull]>;
    mutableFileOperand: Type.TOptional<Type.TUnion<[Type.TObject<{
      argvIndex: Type.TInteger;
      path: Type.TString;
      sha256: Type.TString;
    }>, Type.TNull]>>;
  }>>;
  env: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
  cwd: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  nodeId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  host: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  security: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  ask: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  warningText: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  commandSpans: Type.TOptional<Type.TArray<Type.TObject<{
    startIndex: Type.TInteger;
    endIndex: Type.TInteger;
  }>>>;
  agentId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  resolvedPath: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  sessionKey: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  turnSourceChannel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  turnSourceTo: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  turnSourceAccountId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  turnSourceThreadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber, Type.TNull]>>;
  timeoutMs: Type.TOptional<Type.TInteger>;
  twoPhase: Type.TOptional<Type.TBoolean>;
}>;
declare const ExecApprovalResolveParamsSchema: Type.TObject<{
  id: Type.TString;
  decision: Type.TString;
}>;
//#endregion
//#region src/gateway/protocol/schema/frames.d.ts
declare const TickEventSchema: Type.TObject<{
  ts: Type.TInteger;
}>;
declare const ShutdownEventSchema: Type.TObject<{
  reason: Type.TString;
  restartExpectedMs: Type.TOptional<Type.TInteger>;
}>;
declare const ConnectParamsSchema: Type.TObject<{
  minProtocol: Type.TInteger;
  maxProtocol: Type.TInteger;
  client: Type.TObject<{
    id: Type.TEnum<["webchat-ui", "openclaw-control-ui", "openclaw-tui", "webchat", "cli", "gateway-client", "openclaw-macos", "openclaw-ios", "openclaw-android", "node-host", "test", "fingerprint", "openclaw-probe"]>;
    displayName: Type.TOptional<Type.TString>;
    version: Type.TString;
    platform: Type.TString;
    deviceFamily: Type.TOptional<Type.TString>;
    modelIdentifier: Type.TOptional<Type.TString>;
    mode: Type.TEnum<["webchat", "cli", "test", "probe", "ui", "backend", "node"]>;
    instanceId: Type.TOptional<Type.TString>;
  }>;
  caps: Type.TOptional<Type.TArray<Type.TString>>;
  commands: Type.TOptional<Type.TArray<Type.TString>>;
  permissions: Type.TOptional<Type.TRecord<"^.*$", Type.TBoolean>>;
  pathEnv: Type.TOptional<Type.TString>;
  role: Type.TOptional<Type.TString>;
  scopes: Type.TOptional<Type.TArray<Type.TString>>;
  device: Type.TOptional<Type.TObject<{
    id: Type.TString;
    publicKey: Type.TString;
    signature: Type.TString;
    signedAt: Type.TInteger;
    nonce: Type.TString;
  }>>;
  auth: Type.TOptional<Type.TObject<{
    token: Type.TOptional<Type.TString>;
    bootstrapToken: Type.TOptional<Type.TString>;
    deviceToken: Type.TOptional<Type.TString>;
    password: Type.TOptional<Type.TString>;
    approvalRuntimeToken: Type.TOptional<Type.TString>;
  }>>;
  locale: Type.TOptional<Type.TString>;
  userAgent: Type.TOptional<Type.TString>;
}>;
declare const HelloOkSchema: Type.TObject<{
  type: Type.TLiteral<"hello-ok">;
  protocol: Type.TInteger;
  server: Type.TObject<{
    version: Type.TString;
    connId: Type.TString;
  }>;
  features: Type.TObject<{
    methods: Type.TArray<Type.TString>;
    events: Type.TArray<Type.TString>;
  }>;
  snapshot: Type.TObject<{
    presence: Type.TArray<Type.TObject<{
      host: Type.TOptional<Type.TString>;
      ip: Type.TOptional<Type.TString>;
      version: Type.TOptional<Type.TString>;
      platform: Type.TOptional<Type.TString>;
      deviceFamily: Type.TOptional<Type.TString>;
      modelIdentifier: Type.TOptional<Type.TString>;
      mode: Type.TOptional<Type.TString>;
      lastInputSeconds: Type.TOptional<Type.TInteger>;
      reason: Type.TOptional<Type.TString>;
      tags: Type.TOptional<Type.TArray<Type.TString>>;
      text: Type.TOptional<Type.TString>;
      ts: Type.TInteger;
      deviceId: Type.TOptional<Type.TString>;
      roles: Type.TOptional<Type.TArray<Type.TString>>;
      scopes: Type.TOptional<Type.TArray<Type.TString>>;
      instanceId: Type.TOptional<Type.TString>;
    }>>;
    health: Type.TAny;
    stateVersion: Type.TObject<{
      presence: Type.TInteger;
      health: Type.TInteger;
    }>;
    uptimeMs: Type.TInteger;
    configPath: Type.TOptional<Type.TString>;
    stateDir: Type.TOptional<Type.TString>;
    sessionDefaults: Type.TOptional<Type.TObject<{
      defaultAgentId: Type.TString;
      mainKey: Type.TString;
      mainSessionKey: Type.TString;
      scope: Type.TOptional<Type.TString>;
    }>>;
    authMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"none">, Type.TLiteral<"token">, Type.TLiteral<"password">, Type.TLiteral<"trusted-proxy">]>>;
    updateAvailable: Type.TOptional<Type.TObject<{
      currentVersion: Type.TString;
      latestVersion: Type.TString;
      channel: Type.TString;
    }>>;
  }>;
  pluginSurfaceUrls: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
  auth: Type.TObject<{
    deviceToken: Type.TOptional<Type.TString>;
    role: Type.TString;
    scopes: Type.TArray<Type.TString>;
    issuedAtMs: Type.TOptional<Type.TInteger>;
    deviceTokens: Type.TOptional<Type.TArray<Type.TObject<{
      deviceToken: Type.TString;
      role: Type.TString;
      scopes: Type.TArray<Type.TString>;
      issuedAtMs: Type.TInteger;
    }>>>;
  }>;
  policy: Type.TObject<{
    maxPayload: Type.TInteger;
    maxBufferedBytes: Type.TInteger;
    tickIntervalMs: Type.TInteger;
  }>;
}>;
declare const ErrorShapeSchema: Type.TObject<{
  code: Type.TString;
  message: Type.TString;
  details: Type.TOptional<Type.TUnknown>;
  retryable: Type.TOptional<Type.TBoolean>;
  retryAfterMs: Type.TOptional<Type.TInteger>;
}>;
declare const RequestFrameSchema: Type.TObject<{
  type: Type.TLiteral<"req">;
  id: Type.TString;
  method: Type.TString;
  params: Type.TOptional<Type.TUnknown>;
}>;
declare const ResponseFrameSchema: Type.TObject<{
  type: Type.TLiteral<"res">;
  id: Type.TString;
  ok: Type.TBoolean;
  payload: Type.TOptional<Type.TUnknown>;
  error: Type.TOptional<Type.TObject<{
    code: Type.TString;
    message: Type.TString;
    details: Type.TOptional<Type.TUnknown>;
    retryable: Type.TOptional<Type.TBoolean>;
    retryAfterMs: Type.TOptional<Type.TInteger>;
  }>>;
}>;
declare const EventFrameSchema: Type.TObject<{
  type: Type.TLiteral<"event">;
  event: Type.TString;
  payload: Type.TOptional<Type.TUnknown>;
  seq: Type.TOptional<Type.TInteger>;
  stateVersion: Type.TOptional<Type.TObject<{
    presence: Type.TInteger;
    health: Type.TInteger;
  }>>;
}>;
declare const GatewayFrameSchema: Type.TUnion<[Type.TObject<{
  type: Type.TLiteral<"req">;
  id: Type.TString;
  method: Type.TString;
  params: Type.TOptional<Type.TUnknown>;
}>, Type.TObject<{
  type: Type.TLiteral<"res">;
  id: Type.TString;
  ok: Type.TBoolean;
  payload: Type.TOptional<Type.TUnknown>;
  error: Type.TOptional<Type.TObject<{
    code: Type.TString;
    message: Type.TString;
    details: Type.TOptional<Type.TUnknown>;
    retryable: Type.TOptional<Type.TBoolean>;
    retryAfterMs: Type.TOptional<Type.TInteger>;
  }>>;
}>, Type.TObject<{
  type: Type.TLiteral<"event">;
  event: Type.TString;
  payload: Type.TOptional<Type.TUnknown>;
  seq: Type.TOptional<Type.TInteger>;
  stateVersion: Type.TOptional<Type.TObject<{
    presence: Type.TInteger;
    health: Type.TInteger;
  }>>;
}>]>;
//#endregion
//#region src/gateway/protocol/schema/logs-chat.d.ts
declare const LogsTailParamsSchema: Type.TObject<{
  cursor: Type.TOptional<Type.TInteger>;
  limit: Type.TOptional<Type.TInteger>;
  maxBytes: Type.TOptional<Type.TInteger>;
}>;
declare const LogsTailResultSchema: Type.TObject<{
  file: Type.TString;
  cursor: Type.TInteger;
  size: Type.TInteger;
  lines: Type.TArray<Type.TString>;
  truncated: Type.TOptional<Type.TBoolean>;
  reset: Type.TOptional<Type.TBoolean>;
}>;
declare const ChatHistoryParamsSchema: Type.TObject<{
  sessionKey: Type.TString;
  limit: Type.TOptional<Type.TInteger>;
  maxChars: Type.TOptional<Type.TInteger>;
}>;
declare const ChatSendParamsSchema: Type.TObject<{
  sessionKey: Type.TString;
  sessionId: Type.TOptional<Type.TString>;
  message: Type.TString;
  thinking: Type.TOptional<Type.TString>;
  fastMode: Type.TOptional<Type.TBoolean>;
  deliver: Type.TOptional<Type.TBoolean>;
  originatingChannel: Type.TOptional<Type.TString>;
  originatingTo: Type.TOptional<Type.TString>;
  originatingAccountId: Type.TOptional<Type.TString>;
  originatingThreadId: Type.TOptional<Type.TString>;
  attachments: Type.TOptional<Type.TArray<Type.TUnknown>>;
  timeoutMs: Type.TOptional<Type.TInteger>;
  systemInputProvenance: Type.TOptional<Type.TObject<{
    kind: Type.TString;
    originSessionId: Type.TOptional<Type.TString>;
    sourceSessionKey: Type.TOptional<Type.TString>;
    sourceChannel: Type.TOptional<Type.TString>;
    sourceTool: Type.TOptional<Type.TString>;
  }>>;
  systemProvenanceReceipt: Type.TOptional<Type.TString>;
  idempotencyKey: Type.TString;
}>;
declare const ChatInjectParamsSchema: Type.TObject<{
  sessionKey: Type.TString;
  message: Type.TString;
  label: Type.TOptional<Type.TString>;
}>;
declare const ChatEventSchema: Type.TUnion<[Type.TObject<{
  state: Type.TLiteral<"delta">;
  message: Type.TOptional<Type.TUnknown>;
  deltaText: Type.TString;
  replace: Type.TOptional<Type.TBoolean>;
  usage: Type.TOptional<Type.TUnknown>;
  runId: Type.TString;
  sessionKey: Type.TString;
  spawnedBy: Type.TOptional<Type.TString>;
  seq: Type.TInteger;
}>, Type.TObject<{
  state: Type.TLiteral<"final">;
  message: Type.TOptional<Type.TUnknown>;
  usage: Type.TOptional<Type.TUnknown>;
  stopReason: Type.TOptional<Type.TString>;
  runId: Type.TString;
  sessionKey: Type.TString;
  spawnedBy: Type.TOptional<Type.TString>;
  seq: Type.TInteger;
}>, Type.TObject<{
  state: Type.TLiteral<"aborted">;
  message: Type.TOptional<Type.TUnknown>;
  stopReason: Type.TOptional<Type.TString>;
  runId: Type.TString;
  sessionKey: Type.TString;
  spawnedBy: Type.TOptional<Type.TString>;
  seq: Type.TInteger;
}>, Type.TObject<{
  state: Type.TLiteral<"error">;
  message: Type.TOptional<Type.TUnknown>;
  errorMessage: Type.TOptional<Type.TString>;
  errorKind: Type.TOptional<Type.TUnion<[Type.TLiteral<"refusal">, Type.TLiteral<"timeout">, Type.TLiteral<"rate_limit">, Type.TLiteral<"context_length">, Type.TLiteral<"unknown">]>>;
  usage: Type.TOptional<Type.TUnknown>;
  stopReason: Type.TOptional<Type.TString>;
  runId: Type.TString;
  sessionKey: Type.TString;
  spawnedBy: Type.TOptional<Type.TString>;
  seq: Type.TInteger;
}>]>;
//#endregion
//#region src/gateway/protocol/schema/nodes.d.ts
declare const NodePresenceAliveReasonSchema: Type.TString;
declare const NodePresenceAlivePayloadSchema: Type.TObject<{
  trigger: Type.TString;
  sentAtMs: Type.TOptional<Type.TInteger>;
  displayName: Type.TOptional<Type.TString>;
  version: Type.TOptional<Type.TString>;
  platform: Type.TOptional<Type.TString>;
  deviceFamily: Type.TOptional<Type.TString>;
  modelIdentifier: Type.TOptional<Type.TString>;
  pushTransport: Type.TOptional<Type.TString>;
}>;
declare const NodeEventResultSchema: Type.TObject<{
  ok: Type.TBoolean;
  event: Type.TString;
  handled: Type.TBoolean;
  reason: Type.TOptional<Type.TString>;
}>;
declare const NodePairRequestParamsSchema: Type.TObject<{
  nodeId: Type.TString;
  displayName: Type.TOptional<Type.TString>;
  platform: Type.TOptional<Type.TString>;
  version: Type.TOptional<Type.TString>;
  coreVersion: Type.TOptional<Type.TString>;
  uiVersion: Type.TOptional<Type.TString>;
  deviceFamily: Type.TOptional<Type.TString>;
  modelIdentifier: Type.TOptional<Type.TString>;
  caps: Type.TOptional<Type.TArray<Type.TString>>;
  commands: Type.TOptional<Type.TArray<Type.TString>>;
  permissions: Type.TOptional<Type.TRecord<"^.*$", Type.TBoolean>>;
  remoteIp: Type.TOptional<Type.TString>;
  silent: Type.TOptional<Type.TBoolean>;
}>;
declare const NodePairListParamsSchema: Type.TObject<{}>;
declare const NodePairApproveParamsSchema: Type.TObject<{
  requestId: Type.TString;
}>;
declare const NodePairRejectParamsSchema: Type.TObject<{
  requestId: Type.TString;
}>;
declare const NodePairRemoveParamsSchema: Type.TObject<{
  nodeId: Type.TString;
}>;
declare const NodePairVerifyParamsSchema: Type.TObject<{
  nodeId: Type.TString;
  token: Type.TString;
}>;
declare const NodeListParamsSchema: Type.TObject<{}>;
declare const NodePendingAckParamsSchema: Type.TObject<{
  ids: Type.TArray<Type.TString>;
}>;
declare const NodeInvokeParamsSchema: Type.TObject<{
  nodeId: Type.TString;
  command: Type.TString;
  params: Type.TOptional<Type.TUnknown>;
  timeoutMs: Type.TOptional<Type.TInteger>;
  idempotencyKey: Type.TString;
}>;
declare const NodePendingDrainParamsSchema: Type.TObject<{
  maxItems: Type.TOptional<Type.TInteger>;
}>;
declare const NodePendingDrainResultSchema: Type.TObject<{
  nodeId: Type.TString;
  revision: Type.TInteger;
  items: Type.TArray<Type.TObject<{
    id: Type.TString;
    type: Type.TString;
    priority: Type.TString;
    createdAtMs: Type.TInteger;
    expiresAtMs: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
    payload: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
  }>>;
  hasMore: Type.TBoolean;
}>;
declare const NodePendingEnqueueParamsSchema: Type.TObject<{
  nodeId: Type.TString;
  type: Type.TString;
  priority: Type.TOptional<Type.TString>;
  expiresInMs: Type.TOptional<Type.TInteger>;
  wake: Type.TOptional<Type.TBoolean>;
}>;
declare const NodePendingEnqueueResultSchema: Type.TObject<{
  nodeId: Type.TString;
  revision: Type.TInteger;
  queued: Type.TObject<{
    id: Type.TString;
    type: Type.TString;
    priority: Type.TString;
    createdAtMs: Type.TInteger;
    expiresAtMs: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
    payload: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
  }>;
  wakeTriggered: Type.TBoolean;
}>;
//#endregion
//#region src/gateway/protocol/schema/push.d.ts
declare const PushTestParamsSchema: Type.TObject<{
  nodeId: Type.TString;
  title: Type.TOptional<Type.TString>;
  body: Type.TOptional<Type.TString>;
  environment: Type.TOptional<Type.TString>;
}>;
declare const PushTestResultSchema: Type.TObject<{
  ok: Type.TBoolean;
  status: Type.TInteger;
  apnsId: Type.TOptional<Type.TString>;
  reason: Type.TOptional<Type.TString>;
  tokenSuffix: Type.TString;
  topic: Type.TString;
  environment: Type.TString;
  transport: Type.TString;
}>;
declare const WebPushVapidPublicKeyParamsSchema: Type.TObject<{}>;
declare const WebPushSubscribeParamsSchema: Type.TObject<{
  endpoint: Type.TString;
  keys: Type.TObject<{
    p256dh: Type.TString;
    auth: Type.TString;
  }>;
}>;
declare const WebPushUnsubscribeParamsSchema: Type.TObject<{
  endpoint: Type.TString;
}>;
declare const WebPushTestParamsSchema: Type.TObject<{
  title: Type.TOptional<Type.TString>;
  body: Type.TOptional<Type.TString>;
}>;
type WebPushVapidPublicKeyParams = Record<string, never>;
type WebPushSubscribeParams = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};
type WebPushUnsubscribeParams = {
  endpoint: string;
};
type WebPushTestParams = {
  title?: string;
  body?: string;
};
//#endregion
//#region src/gateway/protocol/schema/sessions.d.ts
declare const SessionsListParamsSchema: Type.TObject<{
  /**
   * Maximum rows to return. Omitted Gateway RPC calls use a bounded default
   * to keep large session stores from monopolizing the event loop.
   */
  limit: Type.TOptional<Type.TInteger>;
  offset: Type.TOptional<Type.TInteger>;
  activeMinutes: Type.TOptional<Type.TInteger>;
  includeGlobal: Type.TOptional<Type.TBoolean>;
  includeUnknown: Type.TOptional<Type.TBoolean>;
  /**
   * Limit returned agent-scoped rows to agents currently present in config.
   * Broad disk discovery remains the default for recovery/ACP consumers.
   */
  configuredAgentsOnly: Type.TOptional<Type.TBoolean>;
  /**
   * Read first 8KB of each session transcript to derive title from first user message.
   * Performs a file read per session - use `limit` to bound result set on large stores.
   */
  includeDerivedTitles: Type.TOptional<Type.TBoolean>;
  /**
   * Read last 16KB of each session transcript to extract most recent message preview.
   * Performs a file read per session - use `limit` to bound result set on large stores.
   */
  includeLastMessage: Type.TOptional<Type.TBoolean>;
  label: Type.TOptional<Type.TString>;
  spawnedBy: Type.TOptional<Type.TString>;
  agentId: Type.TOptional<Type.TString>;
  search: Type.TOptional<Type.TString>;
}>;
declare const SessionsCleanupParamsSchema: Type.TObject<{
  agent: Type.TOptional<Type.TString>;
  allAgents: Type.TOptional<Type.TBoolean>;
  enforce: Type.TOptional<Type.TBoolean>;
  activeKey: Type.TOptional<Type.TString>;
  fixMissing: Type.TOptional<Type.TBoolean>;
  fixDmScope: Type.TOptional<Type.TBoolean>;
}>;
declare const SessionsPreviewParamsSchema: Type.TObject<{
  keys: Type.TArray<Type.TString>;
  limit: Type.TOptional<Type.TInteger>;
  maxChars: Type.TOptional<Type.TInteger>;
}>;
declare const SessionsDescribeParamsSchema: Type.TObject<{
  key: Type.TString;
  includeDerivedTitles: Type.TOptional<Type.TBoolean>;
  includeLastMessage: Type.TOptional<Type.TBoolean>;
}>;
declare const SessionsResolveParamsSchema: Type.TObject<{
  key: Type.TOptional<Type.TString>;
  sessionId: Type.TOptional<Type.TString>;
  label: Type.TOptional<Type.TString>;
  agentId: Type.TOptional<Type.TString>;
  spawnedBy: Type.TOptional<Type.TString>;
  includeGlobal: Type.TOptional<Type.TBoolean>;
  includeUnknown: Type.TOptional<Type.TBoolean>;
}>;
declare const SessionsCreateParamsSchema: Type.TObject<{
  key: Type.TOptional<Type.TString>;
  agentId: Type.TOptional<Type.TString>;
  label: Type.TOptional<Type.TString>;
  model: Type.TOptional<Type.TString>;
  parentSessionKey: Type.TOptional<Type.TString>;
  emitCommandHooks: Type.TOptional<Type.TBoolean>;
  task: Type.TOptional<Type.TString>;
  message: Type.TOptional<Type.TString>;
}>;
declare const SessionsSendParamsSchema: Type.TObject<{
  key: Type.TString;
  message: Type.TString;
  thinking: Type.TOptional<Type.TString>;
  attachments: Type.TOptional<Type.TArray<Type.TUnknown>>;
  timeoutMs: Type.TOptional<Type.TInteger>;
  idempotencyKey: Type.TOptional<Type.TString>;
}>;
declare const SessionsAbortParamsSchema: Type.TObject<{
  key: Type.TOptional<Type.TString>;
  runId: Type.TOptional<Type.TString>;
  agentId: Type.TOptional<Type.TString>;
}>;
declare const SessionsPatchParamsSchema: Type.TObject<{
  key: Type.TString;
  label: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  thinkingLevel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  fastMode: Type.TOptional<Type.TUnion<[Type.TBoolean, Type.TNull]>>;
  verboseLevel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  traceLevel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  reasoningLevel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  responseUsage: Type.TOptional<Type.TUnion<[Type.TLiteral<"off">, Type.TLiteral<"tokens">, Type.TLiteral<"full">, Type.TLiteral<"on">, Type.TNull]>>;
  elevatedLevel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  execHost: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  execSecurity: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  execAsk: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  execNode: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  model: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  spawnedBy: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  spawnedWorkspaceDir: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
  spawnDepth: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
  subagentRole: Type.TOptional<Type.TUnion<[Type.TLiteral<"orchestrator">, Type.TLiteral<"leaf">, Type.TNull]>>;
  subagentControlScope: Type.TOptional<Type.TUnion<[Type.TLiteral<"children">, Type.TLiteral<"none">, Type.TNull]>>;
  inheritedToolAllow: Type.TOptional<Type.TUnion<[Type.TArray<Type.TString>, Type.TNull]>>;
  inheritedToolDeny: Type.TOptional<Type.TUnion<[Type.TArray<Type.TString>, Type.TNull]>>;
  sendPolicy: Type.TOptional<Type.TUnion<[Type.TLiteral<"allow">, Type.TLiteral<"deny">, Type.TNull]>>;
  groupActivation: Type.TOptional<Type.TUnion<[Type.TLiteral<"mention">, Type.TLiteral<"always">, Type.TNull]>>;
}>;
declare const SessionsPluginPatchParamsSchema: Type.TObject<{
  key: Type.TString;
  pluginId: Type.TString;
  namespace: Type.TString;
  value: Type.TOptional<Type.TUnknown>;
  unset: Type.TOptional<Type.TBoolean>;
}>;
declare const SessionsResetParamsSchema: Type.TObject<{
  key: Type.TString;
  reason: Type.TOptional<Type.TUnion<[Type.TLiteral<"new">, Type.TLiteral<"reset">]>>;
}>;
declare const SessionsDeleteParamsSchema: Type.TObject<{
  key: Type.TString;
  deleteTranscript: Type.TOptional<Type.TBoolean>;
  emitLifecycleHooks: Type.TOptional<Type.TBoolean>;
}>;
declare const SessionsCompactParamsSchema: Type.TObject<{
  key: Type.TString;
  maxLines: Type.TOptional<Type.TInteger>;
}>;
declare const SessionsCompactionListParamsSchema: Type.TObject<{
  key: Type.TString;
}>;
declare const SessionsCompactionGetParamsSchema: Type.TObject<{
  key: Type.TString;
  checkpointId: Type.TString;
}>;
declare const SessionsCompactionBranchParamsSchema: Type.TObject<{
  key: Type.TString;
  checkpointId: Type.TString;
}>;
declare const SessionsCompactionRestoreParamsSchema: Type.TObject<{
  key: Type.TString;
  checkpointId: Type.TString;
}>;
declare const SessionsUsageParamsSchema: Type.TObject<{
  /** Specific session key to analyze; if omitted returns sessions for the effective agent. */key: Type.TOptional<Type.TString>; /** Agent scope for list-style usage queries. */
  agentId: Type.TOptional<Type.TString>; /** Start date for range filter (YYYY-MM-DD). */
  startDate: Type.TOptional<Type.TString>; /** End date for range filter (YYYY-MM-DD). */
  endDate: Type.TOptional<Type.TString>; /** How start/end dates should be interpreted. Defaults to UTC when omitted. */
  mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"utc">, Type.TLiteral<"gateway">, Type.TLiteral<"specific">]>>; /** Preset range for usage queries when explicit start/end dates are omitted. */
  range: Type.TOptional<Type.TUnion<[Type.TLiteral<"7d">, Type.TLiteral<"30d">, Type.TLiteral<"90d">, Type.TLiteral<"1y">, Type.TLiteral<"all">]>>; /** Usage row grouping. `family` rolls up known rotated session ids for a logical key. */
  groupBy: Type.TOptional<Type.TUnion<[Type.TLiteral<"instance">, Type.TLiteral<"family">]>>; /** Backward-compatible alias for requesting family grouping. */
  includeHistorical: Type.TOptional<Type.TBoolean>; /** UTC offset to use when mode is `specific` (for example, UTC-4 or UTC+5:30). */
  utcOffset: Type.TOptional<Type.TString>; /** Maximum sessions to return (default 50). */
  limit: Type.TOptional<Type.TInteger>; /** Include context weight breakdown (systemPromptReport). */
  includeContextWeight: Type.TOptional<Type.TBoolean>;
}>;
//#endregion
//#region src/gateway/protocol/schema/snapshot.d.ts
declare const PresenceEntrySchema: Type.TObject<{
  host: Type.TOptional<Type.TString>;
  ip: Type.TOptional<Type.TString>;
  version: Type.TOptional<Type.TString>;
  platform: Type.TOptional<Type.TString>;
  deviceFamily: Type.TOptional<Type.TString>;
  modelIdentifier: Type.TOptional<Type.TString>;
  mode: Type.TOptional<Type.TString>;
  lastInputSeconds: Type.TOptional<Type.TInteger>;
  reason: Type.TOptional<Type.TString>;
  tags: Type.TOptional<Type.TArray<Type.TString>>;
  text: Type.TOptional<Type.TString>;
  ts: Type.TInteger;
  deviceId: Type.TOptional<Type.TString>;
  roles: Type.TOptional<Type.TArray<Type.TString>>;
  scopes: Type.TOptional<Type.TArray<Type.TString>>;
  instanceId: Type.TOptional<Type.TString>;
}>;
declare const StateVersionSchema: Type.TObject<{
  presence: Type.TInteger;
  health: Type.TInteger;
}>;
declare const SnapshotSchema: Type.TObject<{
  presence: Type.TArray<Type.TObject<{
    host: Type.TOptional<Type.TString>;
    ip: Type.TOptional<Type.TString>;
    version: Type.TOptional<Type.TString>;
    platform: Type.TOptional<Type.TString>;
    deviceFamily: Type.TOptional<Type.TString>;
    modelIdentifier: Type.TOptional<Type.TString>;
    mode: Type.TOptional<Type.TString>;
    lastInputSeconds: Type.TOptional<Type.TInteger>;
    reason: Type.TOptional<Type.TString>;
    tags: Type.TOptional<Type.TArray<Type.TString>>;
    text: Type.TOptional<Type.TString>;
    ts: Type.TInteger;
    deviceId: Type.TOptional<Type.TString>;
    roles: Type.TOptional<Type.TArray<Type.TString>>;
    scopes: Type.TOptional<Type.TArray<Type.TString>>;
    instanceId: Type.TOptional<Type.TString>;
  }>>;
  health: Type.TAny;
  stateVersion: Type.TObject<{
    presence: Type.TInteger;
    health: Type.TInteger;
  }>;
  uptimeMs: Type.TInteger;
  configPath: Type.TOptional<Type.TString>;
  stateDir: Type.TOptional<Type.TString>;
  sessionDefaults: Type.TOptional<Type.TObject<{
    defaultAgentId: Type.TString;
    mainKey: Type.TString;
    mainSessionKey: Type.TString;
    scope: Type.TOptional<Type.TString>;
  }>>;
  authMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"none">, Type.TLiteral<"token">, Type.TLiteral<"password">, Type.TLiteral<"trusted-proxy">]>>;
  updateAvailable: Type.TOptional<Type.TObject<{
    currentVersion: Type.TString;
    latestVersion: Type.TString;
    channel: Type.TString;
  }>>;
}>;
//#endregion
//#region src/gateway/protocol/schema/tasks.d.ts
declare const TaskSummarySchema: Type.TObject<{
  id: Type.TString;
  kind: Type.TOptional<Type.TString>;
  runtime: Type.TOptional<Type.TString>;
  status: Type.TUnion<[Type.TLiteral<"queued">, Type.TLiteral<"running">, Type.TLiteral<"completed">, Type.TLiteral<"failed">, Type.TLiteral<"cancelled">, Type.TLiteral<"timed_out">]>;
  title: Type.TOptional<Type.TString>;
  agentId: Type.TOptional<Type.TString>;
  sessionKey: Type.TOptional<Type.TString>;
  childSessionKey: Type.TOptional<Type.TString>;
  ownerKey: Type.TOptional<Type.TString>;
  runId: Type.TOptional<Type.TString>;
  taskId: Type.TOptional<Type.TString>;
  flowId: Type.TOptional<Type.TString>;
  parentTaskId: Type.TOptional<Type.TString>;
  sourceId: Type.TOptional<Type.TString>;
  createdAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
  updatedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
  startedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
  endedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
  progressSummary: Type.TOptional<Type.TString>;
  terminalSummary: Type.TOptional<Type.TString>;
  error: Type.TOptional<Type.TString>;
}>;
declare const TasksListParamsSchema: Type.TObject<{
  status: Type.TOptional<Type.TUnion<[Type.TUnion<[Type.TLiteral<"queued">, Type.TLiteral<"running">, Type.TLiteral<"completed">, Type.TLiteral<"failed">, Type.TLiteral<"cancelled">, Type.TLiteral<"timed_out">]>, Type.TArray<Type.TUnion<[Type.TLiteral<"queued">, Type.TLiteral<"running">, Type.TLiteral<"completed">, Type.TLiteral<"failed">, Type.TLiteral<"cancelled">, Type.TLiteral<"timed_out">]>>]>>;
  agentId: Type.TOptional<Type.TString>;
  sessionKey: Type.TOptional<Type.TString>;
  limit: Type.TOptional<Type.TInteger>;
  cursor: Type.TOptional<Type.TString>;
}>;
declare const TasksListResultSchema: Type.TObject<{
  tasks: Type.TArray<Type.TObject<{
    id: Type.TString;
    kind: Type.TOptional<Type.TString>;
    runtime: Type.TOptional<Type.TString>;
    status: Type.TUnion<[Type.TLiteral<"queued">, Type.TLiteral<"running">, Type.TLiteral<"completed">, Type.TLiteral<"failed">, Type.TLiteral<"cancelled">, Type.TLiteral<"timed_out">]>;
    title: Type.TOptional<Type.TString>;
    agentId: Type.TOptional<Type.TString>;
    sessionKey: Type.TOptional<Type.TString>;
    childSessionKey: Type.TOptional<Type.TString>;
    ownerKey: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
    taskId: Type.TOptional<Type.TString>;
    flowId: Type.TOptional<Type.TString>;
    parentTaskId: Type.TOptional<Type.TString>;
    sourceId: Type.TOptional<Type.TString>;
    createdAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    updatedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    startedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    endedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    progressSummary: Type.TOptional<Type.TString>;
    terminalSummary: Type.TOptional<Type.TString>;
    error: Type.TOptional<Type.TString>;
  }>>;
  nextCursor: Type.TOptional<Type.TString>;
}>;
declare const TasksGetParamsSchema: Type.TObject<{
  taskId: Type.TString;
}>;
declare const TasksGetResultSchema: Type.TObject<{
  task: Type.TObject<{
    id: Type.TString;
    kind: Type.TOptional<Type.TString>;
    runtime: Type.TOptional<Type.TString>;
    status: Type.TUnion<[Type.TLiteral<"queued">, Type.TLiteral<"running">, Type.TLiteral<"completed">, Type.TLiteral<"failed">, Type.TLiteral<"cancelled">, Type.TLiteral<"timed_out">]>;
    title: Type.TOptional<Type.TString>;
    agentId: Type.TOptional<Type.TString>;
    sessionKey: Type.TOptional<Type.TString>;
    childSessionKey: Type.TOptional<Type.TString>;
    ownerKey: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
    taskId: Type.TOptional<Type.TString>;
    flowId: Type.TOptional<Type.TString>;
    parentTaskId: Type.TOptional<Type.TString>;
    sourceId: Type.TOptional<Type.TString>;
    createdAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    updatedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    startedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    endedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    progressSummary: Type.TOptional<Type.TString>;
    terminalSummary: Type.TOptional<Type.TString>;
    error: Type.TOptional<Type.TString>;
  }>;
}>;
declare const TasksCancelParamsSchema: Type.TObject<{
  taskId: Type.TString;
  reason: Type.TOptional<Type.TString>;
}>;
declare const TasksCancelResultSchema: Type.TObject<{
  found: Type.TBoolean;
  cancelled: Type.TBoolean;
  reason: Type.TOptional<Type.TString>;
  task: Type.TOptional<Type.TObject<{
    id: Type.TString;
    kind: Type.TOptional<Type.TString>;
    runtime: Type.TOptional<Type.TString>;
    status: Type.TUnion<[Type.TLiteral<"queued">, Type.TLiteral<"running">, Type.TLiteral<"completed">, Type.TLiteral<"failed">, Type.TLiteral<"cancelled">, Type.TLiteral<"timed_out">]>;
    title: Type.TOptional<Type.TString>;
    agentId: Type.TOptional<Type.TString>;
    sessionKey: Type.TOptional<Type.TString>;
    childSessionKey: Type.TOptional<Type.TString>;
    ownerKey: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
    taskId: Type.TOptional<Type.TString>;
    flowId: Type.TOptional<Type.TString>;
    parentTaskId: Type.TOptional<Type.TString>;
    sourceId: Type.TOptional<Type.TString>;
    createdAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    updatedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    startedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    endedAt: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
    progressSummary: Type.TOptional<Type.TString>;
    terminalSummary: Type.TOptional<Type.TString>;
    error: Type.TOptional<Type.TString>;
  }>>;
}>;
//#endregion
//#region src/gateway/protocol/schema/plugins.d.ts
declare const PluginsUiDescriptorsParamsSchema: Type.TObject<{}>;
declare const PluginsSessionActionParamsSchema: Type.TObject<{
  pluginId: Type.TString;
  actionId: Type.TString;
  sessionKey: Type.TOptional<Type.TString>;
  payload: Type.TOptional<Type.TUnknown>;
}>;
declare const PluginsSessionActionResultSchema: Type.TUnion<[Type.TObject<{
  ok: Type.TLiteral<true>;
  result: Type.TOptional<Type.TUnknown>;
  continueAgent: Type.TOptional<Type.TBoolean>;
  reply: Type.TOptional<Type.TUnknown>;
}>, Type.TObject<{
  ok: Type.TLiteral<false>;
  error: Type.TString;
  code: Type.TOptional<Type.TString>;
  details: Type.TOptional<Type.TUnknown>;
}>]>;
//#endregion
//#region src/gateway/protocol/schema/wizard.d.ts
declare const WizardStartParamsSchema: Type.TObject<{
  mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"local">, Type.TLiteral<"remote">]>>;
  workspace: Type.TOptional<Type.TString>;
}>;
declare const WizardNextParamsSchema: Type.TObject<{
  sessionId: Type.TString;
  answer: Type.TOptional<Type.TObject<{
    stepId: Type.TString;
    value: Type.TOptional<Type.TUnknown>;
  }>>;
}>;
declare const WizardCancelParamsSchema: Type.TObject<{
  sessionId: Type.TString;
}>;
declare const WizardStatusParamsSchema: Type.TObject<{
  sessionId: Type.TString;
}>;
declare const WizardStepSchema: Type.TObject<{
  id: Type.TString;
  type: Type.TUnion<[Type.TLiteral<"note">, Type.TLiteral<"select">, Type.TLiteral<"text">, Type.TLiteral<"confirm">, Type.TLiteral<"multiselect">, Type.TLiteral<"progress">, Type.TLiteral<"action">]>;
  title: Type.TOptional<Type.TString>;
  message: Type.TOptional<Type.TString>;
  format: Type.TOptional<Type.TUnion<[Type.TLiteral<"plain">]>>;
  options: Type.TOptional<Type.TArray<Type.TObject<{
    value: Type.TUnknown;
    label: Type.TString;
    hint: Type.TOptional<Type.TString>;
  }>>>;
  initialValue: Type.TOptional<Type.TUnknown>;
  placeholder: Type.TOptional<Type.TString>;
  sensitive: Type.TOptional<Type.TBoolean>;
  executor: Type.TOptional<Type.TUnion<[Type.TLiteral<"gateway">, Type.TLiteral<"client">]>>;
}>;
declare const WizardNextResultSchema: Type.TObject<{
  done: Type.TBoolean;
  step: Type.TOptional<Type.TObject<{
    id: Type.TString;
    type: Type.TUnion<[Type.TLiteral<"note">, Type.TLiteral<"select">, Type.TLiteral<"text">, Type.TLiteral<"confirm">, Type.TLiteral<"multiselect">, Type.TLiteral<"progress">, Type.TLiteral<"action">]>;
    title: Type.TOptional<Type.TString>;
    message: Type.TOptional<Type.TString>;
    format: Type.TOptional<Type.TUnion<[Type.TLiteral<"plain">]>>;
    options: Type.TOptional<Type.TArray<Type.TObject<{
      value: Type.TUnknown;
      label: Type.TString;
      hint: Type.TOptional<Type.TString>;
    }>>>;
    initialValue: Type.TOptional<Type.TUnknown>;
    placeholder: Type.TOptional<Type.TString>;
    sensitive: Type.TOptional<Type.TBoolean>;
    executor: Type.TOptional<Type.TUnion<[Type.TLiteral<"gateway">, Type.TLiteral<"client">]>>;
  }>>;
  status: Type.TOptional<Type.TUnion<[Type.TLiteral<"running">, Type.TLiteral<"done">, Type.TLiteral<"cancelled">, Type.TLiteral<"error">]>>;
  error: Type.TOptional<Type.TString>;
}>;
declare const WizardStartResultSchema: Type.TObject<{
  done: Type.TBoolean;
  step: Type.TOptional<Type.TObject<{
    id: Type.TString;
    type: Type.TUnion<[Type.TLiteral<"note">, Type.TLiteral<"select">, Type.TLiteral<"text">, Type.TLiteral<"confirm">, Type.TLiteral<"multiselect">, Type.TLiteral<"progress">, Type.TLiteral<"action">]>;
    title: Type.TOptional<Type.TString>;
    message: Type.TOptional<Type.TString>;
    format: Type.TOptional<Type.TUnion<[Type.TLiteral<"plain">]>>;
    options: Type.TOptional<Type.TArray<Type.TObject<{
      value: Type.TUnknown;
      label: Type.TString;
      hint: Type.TOptional<Type.TString>;
    }>>>;
    initialValue: Type.TOptional<Type.TUnknown>;
    placeholder: Type.TOptional<Type.TString>;
    sensitive: Type.TOptional<Type.TBoolean>;
    executor: Type.TOptional<Type.TUnion<[Type.TLiteral<"gateway">, Type.TLiteral<"client">]>>;
  }>>;
  status: Type.TOptional<Type.TUnion<[Type.TLiteral<"running">, Type.TLiteral<"done">, Type.TLiteral<"cancelled">, Type.TLiteral<"error">]>>;
  error: Type.TOptional<Type.TString>;
  sessionId: Type.TString;
}>;
declare const WizardStatusResultSchema: Type.TObject<{
  status: Type.TUnion<[Type.TLiteral<"running">, Type.TLiteral<"done">, Type.TLiteral<"cancelled">, Type.TLiteral<"error">]>;
  error: Type.TOptional<Type.TString>;
}>;
//#endregion
//#region src/gateway/protocol/index.d.ts
declare const validateCommandsListParams: AjvPkg.ValidateFunction<{
  scope?: "text" | "native" | "both" | undefined;
  agentId?: string | undefined;
  provider?: string | undefined;
  includeArgs?: boolean | undefined;
}>;
declare const validateConnectParams: AjvPkg.ValidateFunction<{
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
    version: string;
    id: "webchat-ui" | "openclaw-control-ui" | "openclaw-tui" | "webchat" | "cli" | "gateway-client" | "openclaw-macos" | "openclaw-ios" | "openclaw-android" | "node-host" | "test" | "fingerprint" | "openclaw-probe";
    platform: string;
    mode: "webchat" | "cli" | "test" | "ui" | "backend" | "node" | "probe";
  };
}>;
declare const validateRequestFrame: AjvPkg.ValidateFunction<{
  params?: unknown;
  id: string;
  type: "req";
  method: string;
}>;
declare const validateResponseFrame: AjvPkg.ValidateFunction<{
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
declare const validateEventFrame: AjvPkg.ValidateFunction<{
  stateVersion?: {
    presence: number;
    health: number;
  } | undefined;
  payload?: unknown;
  seq?: number | undefined;
  type: "event";
  event: string;
}>;
declare const validateMessageActionParams: AjvPkg.ValidateFunction<{
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
declare const validateSendParams: AjvPkg.ValidateFunction<unknown>;
declare const validatePollParams: AjvPkg.ValidateFunction<{
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
declare const validateAgentParams: AjvPkg.ValidateFunction<unknown>;
declare const validateAgentIdentityParams: AjvPkg.ValidateFunction<{
  sessionKey?: string | undefined;
  agentId?: string | undefined;
}>;
declare const validateAgentWaitParams: AjvPkg.ValidateFunction<{
  timeoutMs?: number | undefined;
  runId: string;
}>;
declare const validateWakeParams: AjvPkg.ValidateFunction<{
  sessionKey?: string | undefined;
  mode: "now" | "next-heartbeat";
  text: string;
}>;
declare const validateAgentsListParams: AjvPkg.ValidateFunction<object>;
declare const validateAgentsCreateParams: AjvPkg.ValidateFunction<{
  model?: string | undefined;
  avatar?: string | undefined;
  emoji?: string | undefined;
  name: string;
  workspace: string;
}>;
declare const validateAgentsUpdateParams: AjvPkg.ValidateFunction<{
  model?: string | undefined;
  name?: string | undefined;
  avatar?: string | undefined;
  emoji?: string | undefined;
  workspace?: string | undefined;
  agentId: string;
}>;
declare const validateAgentsDeleteParams: AjvPkg.ValidateFunction<{
  deleteFiles?: boolean | undefined;
  agentId: string;
}>;
declare const validateAgentsFilesListParams: AjvPkg.ValidateFunction<{
  agentId: string;
}>;
declare const validateAgentsFilesGetParams: AjvPkg.ValidateFunction<{
  agentId: string;
  name: string;
}>;
declare const validateAgentsFilesSetParams: AjvPkg.ValidateFunction<{
  agentId: string;
  name: string;
  content: string;
}>;
declare const validateArtifactsListParams: AjvPkg.ValidateFunction<{
  runId?: string | undefined;
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  taskId?: string | undefined;
}>;
declare const validateArtifactsGetParams: AjvPkg.ValidateFunction<{
  runId?: string | undefined;
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  taskId?: string | undefined;
  artifactId: string;
}>;
declare const validateArtifactsDownloadParams: AjvPkg.ValidateFunction<{
  runId?: string | undefined;
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  taskId?: string | undefined;
  artifactId: string;
}>;
declare const validateNodePairRequestParams: AjvPkg.ValidateFunction<{
  version?: string | undefined;
  displayName?: string | undefined;
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
declare const validateNodePairListParams: AjvPkg.ValidateFunction<object>;
declare const validateNodePairApproveParams: AjvPkg.ValidateFunction<{
  requestId: string;
}>;
declare const validateNodePairRejectParams: AjvPkg.ValidateFunction<{
  requestId: string;
}>;
declare const validateNodePairRemoveParams: AjvPkg.ValidateFunction<{
  nodeId: string;
}>;
declare const validateNodePairVerifyParams: AjvPkg.ValidateFunction<{
  token: string;
  nodeId: string;
}>;
declare const validateNodeRenameParams: AjvPkg.ValidateFunction<{
  displayName: string;
  nodeId: string;
}>;
declare const validateNodeListParams: AjvPkg.ValidateFunction<object>;
declare const validateEnvironmentsListParams: AjvPkg.ValidateFunction<object>;
declare const validateEnvironmentsStatusParams: AjvPkg.ValidateFunction<{
  environmentId: string;
}>;
declare const validateNodePendingAckParams: AjvPkg.ValidateFunction<{
  ids: string[];
}>;
declare const validateNodeDescribeParams: AjvPkg.ValidateFunction<{
  nodeId: string;
}>;
declare const validateNodeInvokeParams: AjvPkg.ValidateFunction<{
  params?: unknown;
  timeoutMs?: number | undefined;
  idempotencyKey: string;
  nodeId: string;
  command: string;
}>;
declare const validateNodeInvokeResultParams: AjvPkg.ValidateFunction<{
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
declare const validateNodeEventParams: AjvPkg.ValidateFunction<{
  payload?: unknown;
  payloadJSON?: string | undefined;
  event: string;
}>;
declare const validateNodeEventResult: AjvPkg.ValidateFunction<{
  reason?: string | undefined;
  ok: boolean;
  event: string;
  handled: boolean;
}>;
declare const validateNodePresenceAlivePayload: AjvPkg.ValidateFunction<{
  version?: string | undefined;
  displayName?: string | undefined;
  platform?: string | undefined;
  deviceFamily?: string | undefined;
  modelIdentifier?: string | undefined;
  sentAtMs?: number | undefined;
  pushTransport?: string | undefined;
  trigger: string;
}>;
declare const validateNodePendingDrainParams: AjvPkg.ValidateFunction<{
  maxItems?: number | undefined;
}>;
declare const validateNodePendingEnqueueParams: AjvPkg.ValidateFunction<{
  priority?: string | undefined;
  expiresInMs?: number | undefined;
  wake?: boolean | undefined;
  type: string;
  nodeId: string;
}>;
declare const validatePushTestParams: AjvPkg.ValidateFunction<{
  title?: string | undefined;
  body?: string | undefined;
  environment?: string | undefined;
  nodeId: string;
}>;
declare const validateWebPushVapidPublicKeyParams: AjvPkg.ValidateFunction<WebPushVapidPublicKeyParams>;
declare const validateWebPushSubscribeParams: AjvPkg.ValidateFunction<WebPushSubscribeParams>;
declare const validateWebPushUnsubscribeParams: AjvPkg.ValidateFunction<WebPushUnsubscribeParams>;
declare const validateWebPushTestParams: AjvPkg.ValidateFunction<WebPushTestParams>;
declare const validateSecretsResolveParams: AjvPkg.ValidateFunction<{
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
declare const validateSecretsResolveResult: AjvPkg.ValidateFunction<{
  ok?: boolean | undefined;
  assignments?: {
    path?: string | undefined;
    value: unknown;
    pathSegments: string[];
  }[] | undefined;
  diagnostics?: string[] | undefined;
  inactiveRefPaths?: string[] | undefined;
}>;
declare const validateSessionsListParams: AjvPkg.ValidateFunction<{
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
declare const validateSessionsCleanupParams: AjvPkg.ValidateFunction<{
  agent?: string | undefined;
  allAgents?: boolean | undefined;
  enforce?: boolean | undefined;
  activeKey?: string | undefined;
  fixMissing?: boolean | undefined;
  fixDmScope?: boolean | undefined;
}>;
declare const validateSessionsPreviewParams: AjvPkg.ValidateFunction<{
  limit?: number | undefined;
  maxChars?: number | undefined;
  keys: string[];
}>;
declare const validateSessionsDescribeParams: AjvPkg.ValidateFunction<{
  includeDerivedTitles?: boolean | undefined;
  includeLastMessage?: boolean | undefined;
  key: string;
}>;
declare const validateSessionsResolveParams: AjvPkg.ValidateFunction<{
  label?: string | undefined;
  spawnedBy?: string | undefined;
  sessionId?: string | undefined;
  agentId?: string | undefined;
  includeGlobal?: boolean | undefined;
  includeUnknown?: boolean | undefined;
  key?: string | undefined;
}>;
declare const validateSessionsCreateParams: AjvPkg.ValidateFunction<{
  message?: string | undefined;
  label?: string | undefined;
  agentId?: string | undefined;
  model?: string | undefined;
  key?: string | undefined;
  parentSessionKey?: string | undefined;
  emitCommandHooks?: boolean | undefined;
  task?: string | undefined;
}>;
declare const validateSessionsSendParams: AjvPkg.ValidateFunction<{
  idempotencyKey?: string | undefined;
  thinking?: string | undefined;
  attachments?: unknown[] | undefined;
  timeoutMs?: number | undefined;
  message: string;
  key: string;
}>;
declare const validateSessionsMessagesSubscribeParams: AjvPkg.ValidateFunction<{
  key: string;
}>;
declare const validateSessionsMessagesUnsubscribeParams: AjvPkg.ValidateFunction<{
  key: string;
}>;
declare const validateSessionsAbortParams: AjvPkg.ValidateFunction<{
  runId?: string | undefined;
  agentId?: string | undefined;
  key?: string | undefined;
}>;
declare const validateSessionsPatchParams: AjvPkg.ValidateFunction<{
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
  spawnDepth?: number | null | undefined;
  subagentRole?: "orchestrator" | "leaf" | null | undefined;
  subagentControlScope?: "none" | "children" | null | undefined;
  inheritedToolAllow?: string[] | null | undefined;
  inheritedToolDeny?: string[] | null | undefined;
  sendPolicy?: "allow" | "deny" | null | undefined;
  groupActivation?: "mention" | "always" | null | undefined;
  key: string;
}>;
declare const validateSessionsPluginPatchParams: AjvPkg.ValidateFunction<{
  value?: unknown;
  unset?: boolean | undefined;
  key: string;
  pluginId: string;
  namespace: string;
}>;
declare const validateSessionsResetParams: AjvPkg.ValidateFunction<{
  reason?: "new" | "reset" | undefined;
  key: string;
}>;
declare const validateSessionsDeleteParams: AjvPkg.ValidateFunction<{
  deleteTranscript?: boolean | undefined;
  emitLifecycleHooks?: boolean | undefined;
  key: string;
}>;
declare const validateSessionsCompactParams: AjvPkg.ValidateFunction<{
  maxLines?: number | undefined;
  key: string;
}>;
declare const validateSessionsCompactionListParams: AjvPkg.ValidateFunction<{
  key: string;
}>;
declare const validateSessionsCompactionGetParams: AjvPkg.ValidateFunction<{
  key: string;
  checkpointId: string;
}>;
declare const validateSessionsCompactionBranchParams: AjvPkg.ValidateFunction<{
  key: string;
  checkpointId: string;
}>;
declare const validateSessionsCompactionRestoreParams: AjvPkg.ValidateFunction<{
  key: string;
  checkpointId: string;
}>;
declare const validateSessionsUsageParams: AjvPkg.ValidateFunction<{
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
declare const validateTasksListParams: AjvPkg.ValidateFunction<{
  status?: "queued" | "completed" | "running" | "failed" | "cancelled" | "timed_out" | ("queued" | "completed" | "running" | "failed" | "cancelled" | "timed_out")[] | undefined;
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}>;
declare const validateTasksGetParams: AjvPkg.ValidateFunction<{
  taskId: string;
}>;
declare const validateTasksCancelParams: AjvPkg.ValidateFunction<{
  reason?: string | undefined;
  taskId: string;
}>;
declare const validateConfigGetParams: AjvPkg.ValidateFunction<object>;
declare const validateConfigSetParams: AjvPkg.ValidateFunction<{
  baseHash?: string | undefined;
  raw: string;
}>;
declare const validateConfigApplyParams: AjvPkg.ValidateFunction<{
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
declare const validateConfigPatchParams: AjvPkg.ValidateFunction<{
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
declare const validateConfigSchemaParams: AjvPkg.ValidateFunction<object>;
declare const validateConfigSchemaLookupParams: AjvPkg.ValidateFunction<{
  path: string;
}>;
declare const validateConfigSchemaLookupResult: AjvPkg.ValidateFunction<{
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
declare const validateWizardStartParams: AjvPkg.ValidateFunction<{
  mode?: "local" | "remote" | undefined;
  workspace?: string | undefined;
}>;
declare const validateWizardNextParams: AjvPkg.ValidateFunction<{
  answer?: {
    value?: unknown;
    stepId: string;
  } | undefined;
  sessionId: string;
}>;
declare const validateWizardCancelParams: AjvPkg.ValidateFunction<{
  sessionId: string;
}>;
declare const validateWizardStatusParams: AjvPkg.ValidateFunction<{
  sessionId: string;
}>;
declare const validateTalkModeParams: AjvPkg.ValidateFunction<{
  phase?: string | undefined;
  enabled: boolean;
}>;
declare const validateTalkEvent: AjvPkg.ValidateFunction<{
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
declare const validateTalkCatalogParams: AjvPkg.ValidateFunction<object>;
declare const validateTalkCatalogResult: AjvPkg.ValidateFunction<{
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
declare const validateTalkConfigParams: AjvPkg.ValidateFunction<{
  includeSecrets?: boolean | undefined;
}>;
declare const validateTalkConfigResult: AjvPkg.ValidateFunction<{
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
            source: "env";
            id: string;
            provider: string;
          } | {
            source: "file";
            id: string;
            provider: string;
          } | {
            source: "exec";
            id: string;
            provider: string;
          } | undefined;
        }> | undefined;
        voice?: string | undefined;
        instructions?: string | undefined;
      } | undefined;
      providers?: Record<string, {
        apiKey?: string | {
          source: "env";
          id: string;
          provider: string;
        } | {
          source: "file";
          id: string;
          provider: string;
        } | {
          source: "exec";
          id: string;
          provider: string;
        } | undefined;
      }> | undefined;
      resolved?: {
        provider: string;
        config: {
          apiKey?: string | {
            source: "env";
            id: string;
            provider: string;
          } | {
            source: "file";
            id: string;
            provider: string;
          } | {
            source: "exec";
            id: string;
            provider: string;
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
declare const validateTalkClientCreateParams: AjvPkg.ValidateFunction<{
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
declare const validateTalkClientCreateResult: AjvPkg.ValidateFunction<{
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
declare const validateTalkClientToolCallParams: AjvPkg.ValidateFunction<{
  relaySessionId?: string | undefined;
  args?: unknown;
  sessionKey: string;
  name: string;
  callId: string;
}>;
declare const validateTalkClientToolCallResult: AjvPkg.ValidateFunction<{
  runId: string;
  idempotencyKey: string;
}>;
declare const validateTalkSessionCreateParams: AjvPkg.ValidateFunction<{
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
declare const validateTalkSessionCreateResult: AjvPkg.ValidateFunction<{
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
declare const validateTalkSessionJoinParams: AjvPkg.ValidateFunction<{
  token: string;
  sessionId: string;
}>;
declare const validateTalkSessionJoinResult: AjvPkg.ValidateFunction<{
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
declare const validateTalkSessionAppendAudioParams: AjvPkg.ValidateFunction<{
  timestamp?: number | undefined;
  sessionId: string;
  audioBase64: string;
}>;
declare const validateTalkSessionTurnParams: AjvPkg.ValidateFunction<{
  turnId?: string | undefined;
  sessionId: string;
}>;
declare const validateTalkSessionCancelTurnParams: AjvPkg.ValidateFunction<{
  reason?: string | undefined;
  turnId?: string | undefined;
  sessionId: string;
}>;
declare const validateTalkSessionCancelOutputParams: AjvPkg.ValidateFunction<{
  reason?: string | undefined;
  turnId?: string | undefined;
  sessionId: string;
}>;
declare const validateTalkSessionTurnResult: AjvPkg.ValidateFunction<{
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
declare const validateTalkSessionSubmitToolResultParams: AjvPkg.ValidateFunction<{
  options?: {
    suppressResponse?: boolean | undefined;
    willContinue?: boolean | undefined;
  } | undefined;
  sessionId: string;
  result: unknown;
  callId: string;
}>;
declare const validateTalkSessionCloseParams: AjvPkg.ValidateFunction<{
  sessionId: string;
}>;
declare const validateTalkSessionOkResult: AjvPkg.ValidateFunction<{
  ok: boolean;
}>;
declare const validateTalkSpeakParams: AjvPkg.ValidateFunction<{
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
declare const validateTalkSpeakResult: AjvPkg.ValidateFunction<{
  mimeType?: string | undefined;
  outputFormat?: string | undefined;
  voiceCompatible?: boolean | undefined;
  fileExtension?: string | undefined;
  provider: string;
  audioBase64: string;
}>;
declare const validateChannelsStatusParams: AjvPkg.ValidateFunction<{
  probe?: boolean | undefined;
  channel?: string | undefined;
  timeoutMs?: number | undefined;
}>;
declare const validateChannelsStartParams: AjvPkg.ValidateFunction<{
  accountId?: string | undefined;
  channel: string;
}>;
declare const validateChannelsStopParams: AjvPkg.ValidateFunction<{
  accountId?: string | undefined;
  channel: string;
}>;
declare const validateChannelsLogoutParams: AjvPkg.ValidateFunction<{
  accountId?: string | undefined;
  channel: string;
}>;
declare const validateModelsListParams: AjvPkg.ValidateFunction<{
  view?: "default" | "all" | "configured" | undefined;
}>;
declare const validateSkillsStatusParams: AjvPkg.ValidateFunction<{
  agentId?: string | undefined;
}>;
declare const validateToolsCatalogParams: AjvPkg.ValidateFunction<{
  agentId?: string | undefined;
  includePlugins?: boolean | undefined;
}>;
declare const validateToolsEffectiveParams: AjvPkg.ValidateFunction<{
  agentId?: string | undefined;
  sessionKey: string;
}>;
declare const validateToolsInvokeParams: AjvPkg.ValidateFunction<{
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  idempotencyKey?: string | undefined;
  confirm?: boolean | undefined;
  args?: Record<string, unknown> | undefined;
  name: string;
}>;
declare const validateSkillsBinsParams: AjvPkg.ValidateFunction<object>;
declare const validateSkillsInstallParams: AjvPkg.ValidateFunction<{
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
declare const validateSkillsUploadBeginParams: AjvPkg.ValidateFunction<{
  idempotencyKey?: string | undefined;
  force?: boolean | undefined;
  sha256?: string | undefined;
  kind: "skill-archive";
  sizeBytes: number;
  slug: string;
}>;
declare const validateSkillsUploadChunkParams: AjvPkg.ValidateFunction<{
  offset: number;
  uploadId: string;
  dataBase64: string;
}>;
declare const validateSkillsUploadCommitParams: AjvPkg.ValidateFunction<{
  sha256?: string | undefined;
  uploadId: string;
}>;
declare const validateSkillsUpdateParams: AjvPkg.ValidateFunction<{
  env?: Record<string, string> | undefined;
  enabled?: boolean | undefined;
  apiKey?: string | undefined;
  skillKey: string;
} | {
  all?: boolean | undefined;
  slug?: string | undefined;
  source: "clawhub";
}>;
declare const validateSkillsSearchParams: AjvPkg.ValidateFunction<{
  limit?: number | undefined;
  query?: string | undefined;
}>;
declare const validateSkillsDetailParams: AjvPkg.ValidateFunction<{
  slug: string;
}>;
declare const validateCronListParams: AjvPkg.ValidateFunction<{
  agentId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  enabled?: "all" | "enabled" | "disabled" | undefined;
  query?: string | undefined;
  includeDisabled?: boolean | undefined;
  sortBy?: "name" | "updatedAtMs" | "nextRunAtMs" | undefined;
  sortDir?: "asc" | "desc" | undefined;
}>;
declare const validateCronStatusParams: AjvPkg.ValidateFunction<object>;
declare const validateCronGetParams: AjvPkg.ValidateFunction<{
  id: string;
} | {
  jobId: string;
}>;
declare const validateCronAddParams: AjvPkg.ValidateFunction<{
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
declare const validateCronUpdateParams: AjvPkg.ValidateFunction<{
  id: string;
} | {
  jobId: string;
}>;
declare const validateCronRemoveParams: AjvPkg.ValidateFunction<{
  id: string;
} | {
  jobId: string;
}>;
declare const validateCronRunParams: AjvPkg.ValidateFunction<{
  id: string;
} | {
  jobId: string;
}>;
declare const validateCronRunsParams: AjvPkg.ValidateFunction<{
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
declare const validateDevicePairListParams: AjvPkg.ValidateFunction<object>;
declare const validateDevicePairApproveParams: AjvPkg.ValidateFunction<{
  requestId: string;
}>;
declare const validateDevicePairRejectParams: AjvPkg.ValidateFunction<{
  requestId: string;
}>;
declare const validateDevicePairRemoveParams: AjvPkg.ValidateFunction<{
  deviceId: string;
}>;
declare const validateDeviceTokenRotateParams: AjvPkg.ValidateFunction<{
  scopes?: string[] | undefined;
  role: string;
  deviceId: string;
}>;
declare const validateDeviceTokenRevokeParams: AjvPkg.ValidateFunction<{
  role: string;
  deviceId: string;
}>;
declare const validateExecApprovalsGetParams: AjvPkg.ValidateFunction<object>;
declare const validateExecApprovalsSetParams: AjvPkg.ValidateFunction<{
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
        source?: "allow-always" | undefined;
        id?: string | undefined;
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
declare const validateExecApprovalGetParams: AjvPkg.ValidateFunction<{
  id: string;
}>;
declare const validateExecApprovalRequestParams: AjvPkg.ValidateFunction<{
  env?: Record<string, string> | undefined;
  id?: string | undefined;
  host?: string | null | undefined;
  sessionKey?: string | null | undefined;
  agentId?: string | null | undefined;
  timeoutMs?: number | undefined;
  nodeId?: string | null | undefined;
  command?: string | undefined;
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
declare const validateExecApprovalResolveParams: AjvPkg.ValidateFunction<{
  id: string;
  decision: string;
}>;
declare const validatePluginApprovalRequestParams: AjvPkg.ValidateFunction<{
  sessionKey?: string | undefined;
  agentId?: string | undefined;
  timeoutMs?: number | undefined;
  pluginId?: string | undefined;
  toolName?: string | undefined;
  severity?: string | undefined;
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
declare const validatePluginApprovalResolveParams: AjvPkg.ValidateFunction<{
  id: string;
  decision: string;
}>;
declare const validatePluginsUiDescriptorsParams: AjvPkg.ValidateFunction<object>;
declare const validatePluginsSessionActionParams: AjvPkg.ValidateFunction<{
  payload?: unknown;
  sessionKey?: string | undefined;
  pluginId: string;
  actionId: string;
}>;
declare const validatePluginsSessionActionResult: AjvPkg.ValidateFunction<{
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
declare const validateExecApprovalsNodeGetParams: AjvPkg.ValidateFunction<{
  nodeId: string;
}>;
declare const validateExecApprovalsNodeSetParams: AjvPkg.ValidateFunction<{
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
        source?: "allow-always" | undefined;
        id?: string | undefined;
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
declare const validateLogsTailParams: AjvPkg.ValidateFunction<{
  limit?: number | undefined;
  cursor?: number | undefined;
  maxBytes?: number | undefined;
}>;
declare const validateChatHistoryParams: AjvPkg.ValidateFunction<unknown>;
declare const validateChatSendParams: AjvPkg.ValidateFunction<unknown>;
declare const validateChatAbortParams: AjvPkg.ValidateFunction<{
  runId?: string | undefined;
  sessionKey: string;
}>;
declare const validateChatInjectParams: AjvPkg.ValidateFunction<{
  label?: string | undefined;
  message: string;
  sessionKey: string;
}>;
declare const validateChatEvent: AjvPkg.ValidateFunction<unknown>;
declare const validateUpdateStatusParams: AjvPkg.ValidateFunction<object>;
declare const validateUpdateRunParams: AjvPkg.ValidateFunction<{
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
declare const validateWebLoginStartParams: AjvPkg.ValidateFunction<{
  accountId?: string | undefined;
  timeoutMs?: number | undefined;
  force?: boolean | undefined;
  verbose?: boolean | undefined;
}>;
declare const validateWebLoginWaitParams: AjvPkg.ValidateFunction<{
  accountId?: string | undefined;
  timeoutMs?: number | undefined;
  currentQrDataUrl?: string | undefined;
}>;
declare function formatValidationErrors(errors: ErrorObject[] | null | undefined): string;
//#endregion
export { validateExecApprovalsGetParams as $, AgentsUpdateParamsSchema as $a, ConfigSchemaResponseSchema as $i, WizardCancelParamsSchema as $n, NodePairRejectParamsSchema as $r, validateSessionsSendParams as $t, validateConfigSchemaParams as A, TalkSessionTurnResultSchema as Aa, EnvironmentStatusSchema as Ai, validateTalkSessionTurnParams as An, PluginRuntimeLifecycleRegistration as Ao, SessionsListParamsSchema as Ar, validateRequestFrame as At, validateCronUpdateParams as B, AgentsCreateParamsSchema as Ba, CronJobSchema as Bi, validateUpdateRunParams as Bn, PluginSessionTurnScheduleParams as Bo, WebPushSubscribeParams as Br, validateSessionsCompactionListParams as Bt, validateChatSendParams as C, TalkSessionCreateParamsSchema as Ca, ShutdownEventSchema as Ci, validateTalkSessionCloseParams as Cn, SessionsPatchResult as Co, SessionsCompactionBranchParamsSchema as Cr, validatePluginApprovalRequestParams as Ct, validateConfigPatchParams as D, TalkSessionOkResultSchema as Da, ExecApprovalResolveParamsSchema as Di, validateTalkSessionJoinResult as Dn, PluginControlUiDescriptor as Do, SessionsCreateParamsSchema as Dr, validatePluginsUiDescriptorsParams as Dt, validateConfigGetParams as E, TalkSessionJoinResultSchema as Ea, ExecApprovalRequestParamsSchema as Ei, validateTalkSessionJoinParams as En, PluginAgentEventSubscriptionRegistration as Eo, SessionsCompactionRestoreParamsSchema as Er, validatePluginsSessionActionResult as Et, validateCronListParams as F, ArtifactSummarySchema as Fa, EnvironmentsStatusResultSchema as Fi, validateTasksGetParams as Fn, PluginSessionAttachmentResult as Fo, SessionsResolveParamsSchema as Fr, validateSessionsAbortParams as Ft, validateDeviceTokenRevokeParams as G, AgentsFilesGetParamsSchema as Ga, CronStatusParamsSchema as Gi, validateWebPushSubscribeParams as Gn, OperatorScope as Go, WebPushUnsubscribeParamsSchema as Gr, validateSessionsListParams as Gt, validateDevicePairListParams as H, AgentsDeleteParamsSchema as Ha, CronRemoveParamsSchema as Hi, validateWakeParams as Hn, PluginSessionTurnUnscheduleByTagResult as Ho, WebPushTestParams as Hr, validateSessionsCreateParams as Ht, validateCronRemoveParams as I, ArtifactsDownloadParamsSchema as Ia, ErrorCodes as Ii, validateTasksListParams as In, PluginSessionExtensionProjection as Io, SessionsSendParamsSchema as Ir, validateSessionsCleanupParams as It, validateEnvironmentsStatusParams as J, AgentsFilesListResultSchema as Ja, ConfigGetParamsSchema as Ji, validateWebPushVapidPublicKeyParams as Jn, NodeEventResultSchema as Jr, validateSessionsPatchParams as Jt, validateDeviceTokenRotateParams as K, AgentsFilesGetResultSchema as Ka, CronUpdateParamsSchema as Ki, validateWebPushTestParams as Kn, WebPushVapidPublicKeyParams as Kr, validateSessionsMessagesSubscribeParams as Kt, validateCronRunParams as L, ArtifactsGetParamsSchema as La, errorShape as Li, validateToolsCatalogParams as Ln, PluginSessionExtensionRegistration as Lo, SessionsUsageParamsSchema as Lr, validateSessionsCompactParams as Lt, validateConnectParams as M, TalkSpeakResultSchema as Ma, EnvironmentsListParamsSchema as Mi, validateTalkSpeakParams as Mn, PluginSessionActionRegistration as Mo, SessionsPluginPatchParamsSchema as Mr, validateSecretsResolveParams as Mt, validateCronAddParams as N, WebLoginStartParamsSchema as Na, EnvironmentsListResultSchema as Ni, validateTalkSpeakResult as Nn, PluginSessionActionResult as No, SessionsPreviewParamsSchema as Nr, validateSecretsResolveResult as Nt, validateConfigSchemaLookupParams as O, TalkSessionSubmitToolResultParamsSchema as Oa, ExecApprovalsGetParamsSchema as Oi, validateTalkSessionOkResult as On, PluginRunContextGetParams as Oo, SessionsDeleteParamsSchema as Or, validatePollParams as Ot, validateCronGetParams as P, WebLoginWaitParamsSchema as Pa, EnvironmentsStatusParamsSchema as Pi, validateTasksCancelParams as Pn, PluginSessionAttachmentParams as Po, SessionsResetParamsSchema as Pr, validateSendParams as Pt, validateExecApprovalResolveParams as Q, AgentsListResultSchema as Qa, ConfigSchemaParamsSchema as Qi, validateWizardStatusParams as Qn, NodePairListParamsSchema as Qr, validateSessionsResolveParams as Qt, validateCronRunsParams as R, ArtifactsListParamsSchema as Ra, CronAddParamsSchema as Ri, validateToolsEffectiveParams as Rn, PluginSessionSchedulerJobHandle as Ro, PushTestParamsSchema as Rr, validateSessionsCompactionBranchParams as Rt, validateChatInjectParams as S, TalkSessionCloseParamsSchema as Sa, ResponseFrameSchema as Si, validateTalkSessionCancelTurnParams as Sn, WakeParamsSchema as So, SessionsCompactParamsSchema as Sr, validateNodeRenameParams as St, validateConfigApplyParams as T, TalkSessionJoinParamsSchema as Ta, ExecApprovalGetParamsSchema as Ti, validateTalkSessionCreateResult as Tn, PluginAgentEventEmitResult as To, SessionsCompactionListParamsSchema as Tr, validatePluginsSessionActionParams as Tt, validateDevicePairRejectParams as U, AgentsDeleteResultSchema as Ua, CronRunParamsSchema as Ui, validateWebLoginStartParams as Un, PluginToolMetadataRegistration as Uo, WebPushTestParamsSchema as Ur, validateSessionsDeleteParams as Ut, validateDevicePairApproveParams as V, AgentsCreateResultSchema as Va, CronListParamsSchema as Vi, validateUpdateStatusParams as Vn, PluginSessionTurnUnscheduleByTagParams as Vo, WebPushSubscribeParamsSchema as Vr, validateSessionsCompactionRestoreParams as Vt, validateDevicePairRemoveParams as W, AgentsFileEntrySchema as Wa, CronRunsParamsSchema as Wi, validateWebLoginWaitParams as Wn, PluginTrustedToolPolicyRegistration as Wo, WebPushUnsubscribeParams as Wr, validateSessionsDescribeParams as Wt, validateExecApprovalGetParams as X, AgentsFilesSetResultSchema as Xa, ConfigSchemaLookupParamsSchema as Xi, validateWizardNextParams as Xn, NodeListParamsSchema as Xr, validateSessionsPreviewParams as Xt, validateEventFrame as Y, AgentsFilesSetParamsSchema as Ya, ConfigPatchParamsSchema as Yi, validateWizardCancelParams as Yn, NodeInvokeParamsSchema as Yr, validateSessionsPluginPatchParams as Yt, validateExecApprovalRequestParams as Z, AgentsListParamsSchema as Za, ConfigSchemaLookupResultSchema as Zi, validateWizardStartParams as Zn, NodePairApproveParamsSchema as Zr, validateSessionsResetParams as Zt, validateChannelsStatusParams as _, TalkConfigResultSchema as _a, ErrorShapeSchema as _i, validateTalkConfigResult as _n, AgentIdentityResultSchema as _o, PresenceEntrySchema as _r, validateNodePairVerifyParams as _t, validateAgentsCreateParams as a, ChannelsLogoutParamsSchema as aa, NodePendingDrainResultSchema as ai, validateSkillsStatusParams as an, SkillsSearchParamsSchema as ao, WizardStatusResultSchema as ar, validateModelsListParams as at, validateChatEvent as b, TalkSessionCancelOutputParamsSchema as ba, HelloOkSchema as bi, validateTalkSessionAppendAudioParams as bn, PollParamsSchema as bo, SessionsAbortParamsSchema as br, validateNodePendingEnqueueParams as bt, validateAgentsFilesListParams as c, ChannelsStatusResultSchema as ca, NodePresenceAlivePayloadSchema as ci, validateSkillsUploadChunkParams as cn, SkillsUpdateParamsSchema as co, PluginsSessionActionResultSchema as cr, validateNodeEventResult as ct, validateAgentsUpdateParams as d, TalkCatalogResultSchema as da, ChatHistoryParamsSchema as di, validateTalkCatalogResult as dn, SkillsUploadCommitParamsSchema as do, TasksCancelParamsSchema as dr, validateNodeListParams as dt, ConfigSetParamsSchema as ea, NodePairRemoveParamsSchema as ei, validateSessionsUsageParams as en, AgentsUpdateResultSchema as eo, WizardNextParamsSchema as er, validateExecApprovalsNodeGetParams as et, validateArtifactsDownloadParams as f, TalkClientCreateParamsSchema as fa, ChatInjectParamsSchema as fi, validateTalkClientCreateParams as fn, ToolsCatalogParamsSchema as fo, TasksCancelResultSchema as fr, validateNodePairApproveParams as ft, validateChannelsStartParams as g, TalkConfigParamsSchema as ga, ConnectParamsSchema as gi, validateTalkConfigParams as gn, AgentIdentityParamsSchema as go, TasksListResultSchema as gr, validateNodePairRequestParams as gt, validateChannelsLogoutParams as h, TalkClientToolCallResultSchema as ha, LogsTailResultSchema as hi, validateTalkClientToolCallResult as hn, AgentEventSchema as ho, TasksListParamsSchema as hr, validateNodePairRemoveParams as ht, validateAgentWaitParams as i, CommandsListResultSchema as ia, NodePendingDrainParamsSchema as ii, validateSkillsSearchParams as in, SkillsInstallParamsSchema as io, WizardStatusParamsSchema as ir, validateMessageActionParams as it, validateConfigSetParams as j, TalkSpeakParamsSchema as ja, EnvironmentSummarySchema as ji, validateTalkSessionTurnResult as jn, PluginSessionActionContext as jo, SessionsPatchParamsSchema as jr, validateResponseFrame as jt, validateConfigSchemaLookupResult as k, TalkSessionTurnParamsSchema as ka, ExecApprovalsSetParamsSchema as ki, validateTalkSessionSubmitToolResultParams as kn, PluginRunContextPatch as ko, SessionsDescribeParamsSchema as kr, validatePushTestParams as kt, validateAgentsFilesSetParams as l, ChannelsStopParamsSchema as la, NodePresenceAliveReasonSchema as li, validateSkillsUploadCommitParams as ln, SkillsUploadBeginParamsSchema as lo, PluginsUiDescriptorsParamsSchema as lr, validateNodeInvokeParams as lt, validateArtifactsListParams as m, TalkClientToolCallParamsSchema as ma, LogsTailParamsSchema as mi, validateTalkClientToolCallParams as mn, ToolsInvokeParamsSchema as mo, TasksGetResultSchema as mr, validateNodePairRejectParams as mt, validateAgentIdentityParams as n, UpdateStatusParamsSchema as na, NodePairVerifyParamsSchema as ni, validateSkillsDetailParams as nn, SkillsDetailParamsSchema as no, WizardStartParamsSchema as nr, validateExecApprovalsSetParams as nt, validateAgentsDeleteParams as o, ChannelsStartParamsSchema as oa, NodePendingEnqueueParamsSchema as oi, validateSkillsUpdateParams as on, SkillsSearchResultSchema as oo, WizardStepSchema as or, validateNodeDescribeParams as ot, validateArtifactsGetParams as p, TalkClientCreateResultSchema as pa, ChatSendParamsSchema as pi, validateTalkClientCreateResult as pn, ToolsEffectiveParamsSchema as po, TasksGetParamsSchema as pr, validateNodePairListParams as pt, validateEnvironmentsListParams as q, AgentsFilesListParamsSchema as qa, ConfigApplyParamsSchema as qi, validateWebPushUnsubscribeParams as qn, WebPushVapidPublicKeyParamsSchema as qr, validateSessionsMessagesUnsubscribeParams as qt, validateAgentParams as r, CommandsListParamsSchema as ra, NodePendingAckParamsSchema as ri, validateSkillsInstallParams as rn, SkillsDetailResultSchema as ro, WizardStartResultSchema as rr, validateLogsTailParams as rt, validateAgentsFilesGetParams as s, ChannelsStatusParamsSchema as sa, NodePendingEnqueueResultSchema as si, validateSkillsUploadBeginParams as sn, SkillsStatusParamsSchema as so, PluginsSessionActionParamsSchema as sr, validateNodeEventParams as st, formatValidationErrors as t, UpdateRunParamsSchema as ta, NodePairRequestParamsSchema as ti, validateSkillsBinsParams as tn, ModelsListParamsSchema as to, WizardNextResultSchema as tr, validateExecApprovalsNodeSetParams as tt, validateAgentsListParams as u, TalkCatalogParamsSchema as ua, ChatEventSchema as ui, validateTalkCatalogParams as un, SkillsUploadChunkParamsSchema as uo, TaskSummarySchema as ur, validateNodeInvokeResultParams as ut, validateChannelsStopParams as v, TalkEventSchema as va, EventFrameSchema as vi, validateTalkEvent as vn, AgentParamsSchema as vo, SnapshotSchema as vr, validateNodePendingAckParams as vt, validateCommandsListParams as w, TalkSessionCreateResultSchema as wa, TickEventSchema as wi, validateTalkSessionCreateParams as wn, PluginAgentEventEmitParams as wo, SessionsCompactionGetParamsSchema as wr, validatePluginApprovalResolveParams as wt, validateChatHistoryParams as x, TalkSessionCancelTurnParamsSchema as xa, RequestFrameSchema as xi, validateTalkSessionCancelOutputParams as xn, SendParamsSchema as xo, SessionsCleanupParamsSchema as xr, validateNodePresenceAlivePayload as xt, validateChatAbortParams as y, TalkSessionAppendAudioParamsSchema as ya, GatewayFrameSchema as yi, validateTalkModeParams as yn, MessageActionParamsSchema as yo, StateVersionSchema as yr, validateNodePendingDrainParams as yt, validateCronStatusParams as z, AgentSummarySchema as za, CronGetParamsSchema as zi, validateToolsInvokeParams as zn, PluginSessionSchedulerJobRegistration as zo, PushTestResultSchema as zr, validateSessionsCompactionGetParams as zt };