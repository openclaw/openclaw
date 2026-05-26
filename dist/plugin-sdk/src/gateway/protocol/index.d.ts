import { type ErrorObject, type ValidateFunction } from "ajv";
import type { SessionsPatchResult } from "../session-utils.types.js";
import { type AgentEvent, AgentEventSchema, type AgentIdentityParams, AgentIdentityParamsSchema, type AgentIdentityResult, AgentIdentityResultSchema, AgentParamsSchema, MessageActionParamsSchema, type AgentSummary, AgentSummarySchema, type AgentsFileEntry, AgentsFileEntrySchema, type AgentsCreateParams, AgentsCreateParamsSchema, type AgentsCreateResult, AgentsCreateResultSchema, type AgentsUpdateParams, AgentsUpdateParamsSchema, type AgentsUpdateResult, AgentsUpdateResultSchema, type AgentsDeleteParams, AgentsDeleteParamsSchema, type AgentsDeleteResult, AgentsDeleteResultSchema, type AgentsFilesGetParams, AgentsFilesGetParamsSchema, type AgentsFilesGetResult, AgentsFilesGetResultSchema, type AgentsFilesListParams, AgentsFilesListParamsSchema, type AgentsFilesListResult, AgentsFilesListResultSchema, type AgentsFilesSetParams, AgentsFilesSetParamsSchema, type AgentsFilesSetResult, AgentsFilesSetResultSchema, type ArtifactsDownloadParams, ArtifactsDownloadParamsSchema, type ArtifactsDownloadResult, type ArtifactsGetParams, ArtifactsGetParamsSchema, type ArtifactsGetResult, type ArtifactsListParams, ArtifactsListParamsSchema, type ArtifactsListResult, type ArtifactSummary, ArtifactSummarySchema, type AgentsListParams, AgentsListParamsSchema, type AgentsListResult, AgentsListResultSchema, type AgentWaitParams, type ChannelsStartParams, ChannelsStartParamsSchema, type ChannelsStopParams, ChannelsStopParamsSchema, type ChannelsLogoutParams, ChannelsLogoutParamsSchema, TalkEventSchema, type TalkCatalogParams, TalkCatalogParamsSchema, type TalkCatalogResult, TalkCatalogResultSchema, type TalkClientCreateParams, TalkClientCreateParamsSchema, type TalkClientCreateResult, TalkClientCreateResultSchema, type TalkClientToolCallParams, TalkClientToolCallParamsSchema, type TalkClientToolCallResult, TalkClientToolCallResultSchema, type TalkConfigParams, TalkConfigParamsSchema, type TalkConfigResult, TalkConfigResultSchema, type TalkSessionAppendAudioParams, TalkSessionAppendAudioParamsSchema, type TalkSessionCancelOutputParams, TalkSessionCancelOutputParamsSchema, type TalkSessionCancelTurnParams, TalkSessionCancelTurnParamsSchema, type TalkSessionCloseParams, TalkSessionCloseParamsSchema, type TalkSessionCreateParams, TalkSessionCreateParamsSchema, type TalkSessionCreateResult, TalkSessionCreateResultSchema, type TalkSessionJoinParams, TalkSessionJoinParamsSchema, type TalkSessionJoinResult, TalkSessionJoinResultSchema, type TalkSessionOkResult, TalkSessionOkResultSchema, type TalkSessionSubmitToolResultParams, TalkSessionSubmitToolResultParamsSchema, type TalkSessionTurnResult, TalkSessionTurnResultSchema, type TalkSessionTurnParams, TalkSessionTurnParamsSchema, type TalkSpeakParams, TalkSpeakParamsSchema, type TalkSpeakResult, TalkSpeakResultSchema, type ChannelsStatusParams, ChannelsStatusParamsSchema, type ChannelsStatusResult, ChannelsStatusResultSchema, type CommandEntry, type CommandsListParams, CommandsListParamsSchema, type CommandsListResult, CommandsListResultSchema, type ChatEvent, ChatEventSchema, ChatHistoryParamsSchema, type ChatInjectParams, ChatInjectParamsSchema, ChatSendParamsSchema, type ConfigApplyParams, ConfigApplyParamsSchema, type ConfigGetParams, ConfigGetParamsSchema, type ConfigPatchParams, ConfigPatchParamsSchema, ConfigSchemaLookupParamsSchema, ConfigSchemaLookupResultSchema, type ConfigSchemaParams, ConfigSchemaParamsSchema, type ConfigSchemaResponse, ConfigSchemaResponseSchema, type ConfigSetParams, ConfigSetParamsSchema, type UpdateStatusParams, UpdateStatusParamsSchema, type ConnectParams, ConnectParamsSchema, type CronAddParams, CronAddParamsSchema, type CronGetParams, CronGetParamsSchema, type CronJob, CronJobSchema, type CronListParams, CronListParamsSchema, type CronRemoveParams, CronRemoveParamsSchema, type CronRunLogEntry, type CronRunParams, CronRunParamsSchema, type CronRunsParams, CronRunsParamsSchema, type CronStatusParams, CronStatusParamsSchema, type CronUpdateParams, CronUpdateParamsSchema, type DevicePairApproveParams, type DevicePairListParams, type DevicePairRejectParams, type ExecApprovalsGetParams, ExecApprovalsGetParamsSchema, type ExecApprovalsSetParams, ExecApprovalsSetParamsSchema, type ExecApprovalsSnapshot, type ExecApprovalGetParams, ExecApprovalGetParamsSchema, type ExecApprovalRequestParams, ExecApprovalRequestParamsSchema, type ExecApprovalResolveParams, ExecApprovalResolveParamsSchema, type PluginsSessionActionParams, type PluginsSessionActionResult, PluginsSessionActionParamsSchema, PluginsSessionActionResultSchema, PluginsUiDescriptorsParamsSchema, ErrorCodes, type EnvironmentSummary, EnvironmentSummarySchema, type EnvironmentsListParams, EnvironmentsListParamsSchema, type EnvironmentsListResult, EnvironmentsListResultSchema, type EnvironmentsStatusParams, EnvironmentsStatusParamsSchema, type EnvironmentsStatusResult, EnvironmentsStatusResultSchema, type EnvironmentStatus, EnvironmentStatusSchema, type ErrorShape, ErrorShapeSchema, type EventFrame, EventFrameSchema, errorShape, type GatewayFrame, GatewayFrameSchema, type HelloOk, HelloOkSchema, type LogsTailParams, LogsTailParamsSchema, type LogsTailResult, LogsTailResultSchema, ModelsListParamsSchema, type NodeEventParams, type NodeEventResult, NodeEventResultSchema, type NodePendingDrainParams, NodePendingDrainParamsSchema, type NodePendingDrainResult, NodePendingDrainResultSchema, type NodePendingEnqueueParams, NodePendingEnqueueParamsSchema, type NodePendingEnqueueResult, NodePendingEnqueueResultSchema, type NodePresenceAlivePayload, NodePresenceAlivePayloadSchema, type NodePresenceAliveReason, NodePresenceAliveReasonSchema, type NodeInvokeParams, NodeInvokeParamsSchema, type NodeInvokeResultParams, type NodeListParams, NodeListParamsSchema, NodePendingAckParamsSchema, type NodePairApproveParams, NodePairApproveParamsSchema, type NodePairListParams, NodePairListParamsSchema, type NodePairRejectParams, NodePairRejectParamsSchema, type NodePairRemoveParams, NodePairRemoveParamsSchema, type NodePairRequestParams, NodePairRequestParamsSchema, type NodePairVerifyParams, NodePairVerifyParamsSchema, type PollParams, PollParamsSchema, MIN_CLIENT_PROTOCOL_VERSION, MIN_PROBE_PROTOCOL_VERSION, PROTOCOL_VERSION, PushTestParamsSchema, PushTestResultSchema, type WebPushVapidPublicKeyParams, WebPushVapidPublicKeyParamsSchema, type WebPushSubscribeParams, WebPushSubscribeParamsSchema, type WebPushUnsubscribeParams, WebPushUnsubscribeParamsSchema, type WebPushTestParams, WebPushTestParamsSchema, type PresenceEntry, PresenceEntrySchema, ProtocolSchemas, type RequestFrame, RequestFrameSchema, type ResponseFrame, ResponseFrameSchema, SendParamsSchema, SessionsAbortParamsSchema, type SessionsCompactParams, SessionsCompactParamsSchema, type SessionsCleanupParams, SessionsCleanupParamsSchema, SessionsCompactionBranchParamsSchema, SessionsCompactionGetParamsSchema, SessionsCompactionListParamsSchema, SessionsCompactionRestoreParamsSchema, type SessionOperationEvent, SessionsCreateParamsSchema, type SessionsDeleteParams, SessionsDeleteParamsSchema, type SessionsDescribeParams, SessionsDescribeParamsSchema, type SessionsListParams, SessionsListParamsSchema, type SessionsPatchParams, SessionsPatchParamsSchema, SessionsPluginPatchParamsSchema, type SessionsPreviewParams, SessionsPreviewParamsSchema, type SessionsResetParams, SessionsResetParamsSchema, type SessionsResolveParams, SessionsResolveParamsSchema, SessionsSendParamsSchema, type SessionsUsageParams, SessionsUsageParamsSchema, type TaskSummary, TaskSummarySchema, type TasksCancelParams, TasksCancelParamsSchema, type TasksCancelResult, TasksCancelResultSchema, type TasksGetParams, TasksGetParamsSchema, type TasksGetResult, TasksGetResultSchema, type TasksListParams, TasksListParamsSchema, type TasksListResult, TasksListResultSchema, type ShutdownEvent, ShutdownEventSchema, type SkillsBinsParams, type SkillsBinsResult, type SkillsDetailParams, SkillsDetailParamsSchema, type SkillsDetailResult, SkillsDetailResultSchema, type SkillsInstallParams, SkillsInstallParamsSchema, type SkillsSearchParams, SkillsSearchParamsSchema, type SkillsSearchResult, SkillsSearchResultSchema, type SkillsStatusParams, SkillsStatusParamsSchema, type SkillsUploadBeginParams, SkillsUploadBeginParamsSchema, type SkillsUploadChunkParams, SkillsUploadChunkParamsSchema, type SkillsUploadCommitParams, SkillsUploadCommitParamsSchema, type SkillsUpdateParams, SkillsUpdateParamsSchema, type ToolsCatalogParams, ToolsCatalogParamsSchema, type ToolsCatalogResult, type ToolsEffectiveParams, ToolsEffectiveParamsSchema, type ToolsEffectiveResult, type ToolsInvokeParams, ToolsInvokeParamsSchema, type ToolsInvokeResult, type Snapshot, SnapshotSchema, type StateVersion, StateVersionSchema, type TalkModeParams, type TickEvent, TickEventSchema, type UpdateRunParams, UpdateRunParamsSchema, type WakeParams, WakeParamsSchema, type WebLoginStartParams, WebLoginStartParamsSchema, type WebLoginWaitParams, WebLoginWaitParamsSchema, type WizardCancelParams, WizardCancelParamsSchema, type WizardNextParams, WizardNextParamsSchema, type WizardNextResult, WizardNextResultSchema, type WizardStartParams, WizardStartParamsSchema, type WizardStartResult, WizardStartResultSchema, type WizardStatusParams, WizardStatusParamsSchema, type WizardStatusResult, WizardStatusResultSchema, type WizardStep, WizardStepSchema } from "./schema.js";
export declare const validateCommandsListParams: ValidateFunction<{
    agentId?: string | undefined;
    provider?: string | undefined;
    scope?: "both" | "native" | "text" | undefined;
    includeArgs?: boolean | undefined;
}>;
export declare const validateConnectParams: ValidateFunction<{
    minProtocol: number;
    maxProtocol: number;
    client: {
        id: "cli" | "fingerprint" | "gateway-client" | "node-host" | "openclaw-android" | "openclaw-control-ui" | "openclaw-ios" | "openclaw-macos" | "openclaw-probe" | "openclaw-tui" | "test" | "webchat" | "webchat-ui";
        displayName?: string | undefined;
        version: string;
        platform: string;
        deviceFamily?: string | undefined;
        modelIdentifier?: string | undefined;
        mode: "backend" | "cli" | "node" | "probe" | "test" | "ui" | "webchat";
        instanceId?: string | undefined;
    };
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
}>;
export declare const validateRequestFrame: ValidateFunction<{
    type: "req";
    id: string;
    method: string;
    params?: unknown;
}>;
export declare const validateResponseFrame: ValidateFunction<{
    type: "res";
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: {
        code: string;
        message: string;
        details?: unknown;
        retryable?: boolean | undefined;
        retryAfterMs?: number | undefined;
    } | undefined;
}>;
export declare const validateEventFrame: ValidateFunction<{
    type: "event";
    event: string;
    payload?: unknown;
    seq?: number | undefined;
    stateVersion?: {
        presence: number;
        health: number;
    } | undefined;
}>;
export declare const validateMessageActionParams: ValidateFunction<{
    channel: string;
    action: string;
    params: Record<string, unknown>;
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
        replyToMode?: "all" | "batched" | "first" | "off" | undefined;
        hasRepliedRef?: {
            value: boolean;
        } | undefined;
        skipCrossContextDecoration?: boolean | undefined;
    } | undefined;
    idempotencyKey: string;
}>;
export declare const validateSendParams: ValidateFunction<unknown>;
export declare const validatePollParams: ValidateFunction<{
    to: string;
    question: string;
    options: string[];
    maxSelections?: number | undefined;
    durationSeconds?: number | undefined;
    durationHours?: number | undefined;
    silent?: boolean | undefined;
    isAnonymous?: boolean | undefined;
    threadId?: string | undefined;
    channel?: string | undefined;
    accountId?: string | undefined;
    idempotencyKey: string;
}>;
export declare const validateAgentParams: ValidateFunction<unknown>;
export declare const validateAgentIdentityParams: ValidateFunction<{
    agentId?: string | undefined;
    sessionKey?: string | undefined;
}>;
export declare const validateAgentWaitParams: ValidateFunction<{
    runId: string;
    timeoutMs?: number | undefined;
}>;
export declare const validateWakeParams: ValidateFunction<{
    mode: "next-heartbeat" | "now";
    text: string;
    sessionKey?: string | undefined;
}>;
export declare const validateAgentsListParams: ValidateFunction<object>;
export declare const validateAgentsCreateParams: ValidateFunction<{
    name: string;
    workspace: string;
    model?: string | undefined;
    emoji?: string | undefined;
    avatar?: string | undefined;
}>;
export declare const validateAgentsUpdateParams: ValidateFunction<{
    agentId: string;
    name?: string | undefined;
    workspace?: string | undefined;
    model?: string | undefined;
    emoji?: string | undefined;
    avatar?: string | undefined;
}>;
export declare const validateAgentsDeleteParams: ValidateFunction<{
    agentId: string;
    deleteFiles?: boolean | undefined;
}>;
export declare const validateAgentsFilesListParams: ValidateFunction<{
    agentId: string;
}>;
export declare const validateAgentsFilesGetParams: ValidateFunction<{
    agentId: string;
    name: string;
}>;
export declare const validateAgentsFilesSetParams: ValidateFunction<{
    agentId: string;
    name: string;
    content: string;
}>;
export declare const validateArtifactsListParams: ValidateFunction<{
    sessionKey?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
    agentId?: string | undefined;
}>;
export declare const validateArtifactsGetParams: ValidateFunction<{
    sessionKey?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
    agentId?: string | undefined;
    artifactId: string;
}>;
export declare const validateArtifactsDownloadParams: ValidateFunction<{
    sessionKey?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
    agentId?: string | undefined;
    artifactId: string;
}>;
export declare const validateNodePairRequestParams: ValidateFunction<{
    nodeId: string;
    displayName?: string | undefined;
    platform?: string | undefined;
    version?: string | undefined;
    coreVersion?: string | undefined;
    uiVersion?: string | undefined;
    deviceFamily?: string | undefined;
    modelIdentifier?: string | undefined;
    caps?: string[] | undefined;
    commands?: string[] | undefined;
    permissions?: Record<string, boolean> | undefined;
    remoteIp?: string | undefined;
    silent?: boolean | undefined;
}>;
export declare const validateNodePairListParams: ValidateFunction<object>;
export declare const validateNodePairApproveParams: ValidateFunction<{
    requestId: string;
}>;
export declare const validateNodePairRejectParams: ValidateFunction<{
    requestId: string;
}>;
export declare const validateNodePairRemoveParams: ValidateFunction<{
    nodeId: string;
}>;
export declare const validateNodePairVerifyParams: ValidateFunction<{
    nodeId: string;
    token: string;
}>;
export declare const validateNodeRenameParams: ValidateFunction<{
    nodeId: string;
    displayName: string;
}>;
export declare const validateNodeListParams: ValidateFunction<object>;
export declare const validateEnvironmentsListParams: ValidateFunction<object>;
export declare const validateEnvironmentsStatusParams: ValidateFunction<{
    environmentId: string;
}>;
export declare const validateNodePendingAckParams: ValidateFunction<{
    ids: string[];
}>;
export declare const validateNodeDescribeParams: ValidateFunction<{
    nodeId: string;
}>;
export declare const validateNodeInvokeParams: ValidateFunction<{
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number | undefined;
    idempotencyKey: string;
}>;
export declare const validateNodeInvokeResultParams: ValidateFunction<{
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | undefined;
    error?: {
        code?: string | undefined;
        message?: string | undefined;
    } | undefined;
}>;
export declare const validateNodeEventParams: ValidateFunction<{
    event: string;
    payload?: unknown;
    payloadJSON?: string | undefined;
}>;
export declare const validateNodeEventResult: ValidateFunction<{
    ok: boolean;
    event: string;
    handled: boolean;
    reason?: string | undefined;
}>;
export declare const validateNodePresenceAlivePayload: ValidateFunction<{
    trigger: string;
    sentAtMs?: number | undefined;
    displayName?: string | undefined;
    version?: string | undefined;
    platform?: string | undefined;
    deviceFamily?: string | undefined;
    modelIdentifier?: string | undefined;
    pushTransport?: string | undefined;
}>;
export declare const validateNodePendingDrainParams: ValidateFunction<{
    maxItems?: number | undefined;
}>;
export declare const validateNodePendingEnqueueParams: ValidateFunction<{
    nodeId: string;
    type: string;
    priority?: string | undefined;
    expiresInMs?: number | undefined;
    wake?: boolean | undefined;
}>;
export declare const validatePushTestParams: ValidateFunction<{
    nodeId: string;
    title?: string | undefined;
    body?: string | undefined;
    environment?: string | undefined;
}>;
export declare const validateWebPushVapidPublicKeyParams: ValidateFunction<WebPushVapidPublicKeyParams>;
export declare const validateWebPushSubscribeParams: ValidateFunction<WebPushSubscribeParams>;
export declare const validateWebPushUnsubscribeParams: ValidateFunction<WebPushUnsubscribeParams>;
export declare const validateWebPushTestParams: ValidateFunction<WebPushTestParams>;
export declare const validateSecretsResolveParams: ValidateFunction<{
    commandName: string;
    targetIds: string[];
    allowedPaths?: string[] | undefined;
    forcedActivePaths?: string[] | undefined;
    optionalActivePaths?: string[] | undefined;
    providerOverrides?: {
        webSearch?: string | undefined;
        webFetch?: string | undefined;
    } | undefined;
}>;
export declare const validateSecretsResolveResult: ValidateFunction<{
    ok?: boolean | undefined;
    assignments?: {
        path?: string | undefined;
        pathSegments: string[];
        value: unknown;
    }[] | undefined;
    diagnostics?: string[] | undefined;
    inactiveRefPaths?: string[] | undefined;
}>;
export declare const validateSessionsListParams: ValidateFunction<{
    limit?: number | undefined;
    offset?: number | undefined;
    activeMinutes?: number | undefined;
    includeGlobal?: boolean | undefined;
    includeUnknown?: boolean | undefined;
    configuredAgentsOnly?: boolean | undefined;
    includeDerivedTitles?: boolean | undefined;
    includeLastMessage?: boolean | undefined;
    label?: string | undefined;
    spawnedBy?: string | undefined;
    agentId?: string | undefined;
    search?: string | undefined;
}>;
export declare const validateSessionsCleanupParams: ValidateFunction<{
    agent?: string | undefined;
    allAgents?: boolean | undefined;
    enforce?: boolean | undefined;
    activeKey?: string | undefined;
    fixMissing?: boolean | undefined;
    fixDmScope?: boolean | undefined;
}>;
export declare const validateSessionsPreviewParams: ValidateFunction<{
    keys: string[];
    limit?: number | undefined;
    maxChars?: number | undefined;
}>;
export declare const validateSessionsDescribeParams: ValidateFunction<{
    key: string;
    includeDerivedTitles?: boolean | undefined;
    includeLastMessage?: boolean | undefined;
}>;
export declare const validateSessionsResolveParams: ValidateFunction<{
    key?: string | undefined;
    sessionId?: string | undefined;
    label?: string | undefined;
    agentId?: string | undefined;
    spawnedBy?: string | undefined;
    includeGlobal?: boolean | undefined;
    includeUnknown?: boolean | undefined;
}>;
export declare const validateSessionsCreateParams: ValidateFunction<{
    key?: string | undefined;
    agentId?: string | undefined;
    label?: string | undefined;
    model?: string | undefined;
    parentSessionKey?: string | undefined;
    emitCommandHooks?: boolean | undefined;
    task?: string | undefined;
    message?: string | undefined;
}>;
export declare const validateSessionsSendParams: ValidateFunction<{
    key: string;
    message: string;
    thinking?: string | undefined;
    attachments?: unknown[] | undefined;
    timeoutMs?: number | undefined;
    idempotencyKey?: string | undefined;
}>;
export declare const validateSessionsMessagesSubscribeParams: ValidateFunction<{
    key: string;
}>;
export declare const validateSessionsMessagesUnsubscribeParams: ValidateFunction<{
    key: string;
}>;
export declare const validateSessionsAbortParams: ValidateFunction<{
    key?: string | undefined;
    runId?: string | undefined;
    agentId?: string | undefined;
}>;
export declare const validateSessionsPatchParams: ValidateFunction<{
    key: string;
    label?: string | null | undefined;
    thinkingLevel?: string | null | undefined;
    fastMode?: boolean | null | undefined;
    verboseLevel?: string | null | undefined;
    traceLevel?: string | null | undefined;
    reasoningLevel?: string | null | undefined;
    responseUsage?: "full" | "off" | "on" | "tokens" | null | undefined;
    elevatedLevel?: string | null | undefined;
    execHost?: string | null | undefined;
    execSecurity?: string | null | undefined;
    execAsk?: string | null | undefined;
    execNode?: string | null | undefined;
    model?: string | null | undefined;
    spawnedBy?: string | null | undefined;
    spawnedWorkspaceDir?: string | null | undefined;
    spawnDepth?: number | null | undefined;
    subagentRole?: "leaf" | "orchestrator" | null | undefined;
    subagentControlScope?: "children" | "none" | null | undefined;
    inheritedToolAllow?: string[] | null | undefined;
    inheritedToolDeny?: string[] | null | undefined;
    sendPolicy?: "allow" | "deny" | null | undefined;
    groupActivation?: "always" | "mention" | null | undefined;
}>;
export declare const validateSessionsPluginPatchParams: ValidateFunction<{
    key: string;
    pluginId: string;
    namespace: string;
    value?: unknown;
    unset?: boolean | undefined;
}>;
export declare const validateSessionsResetParams: ValidateFunction<{
    key: string;
    reason?: "new" | "reset" | undefined;
}>;
export declare const validateSessionsDeleteParams: ValidateFunction<{
    key: string;
    deleteTranscript?: boolean | undefined;
    emitLifecycleHooks?: boolean | undefined;
}>;
export declare const validateSessionsCompactParams: ValidateFunction<{
    key: string;
    maxLines?: number | undefined;
}>;
export declare const validateSessionsCompactionListParams: ValidateFunction<{
    key: string;
}>;
export declare const validateSessionsCompactionGetParams: ValidateFunction<{
    key: string;
    checkpointId: string;
}>;
export declare const validateSessionsCompactionBranchParams: ValidateFunction<{
    key: string;
    checkpointId: string;
}>;
export declare const validateSessionsCompactionRestoreParams: ValidateFunction<{
    key: string;
    checkpointId: string;
}>;
export declare const validateSessionsUsageParams: ValidateFunction<{
    key?: string | undefined;
    agentId?: string | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
    mode?: "gateway" | "specific" | "utc" | undefined;
    range?: "1y" | "30d" | "7d" | "90d" | "all" | undefined;
    groupBy?: "family" | "instance" | undefined;
    includeHistorical?: boolean | undefined;
    utcOffset?: string | undefined;
    limit?: number | undefined;
    includeContextWeight?: boolean | undefined;
}>;
export declare const validateTasksListParams: ValidateFunction<{
    status?: "cancelled" | "completed" | "failed" | "queued" | "running" | "timed_out" | ("cancelled" | "completed" | "failed" | "queued" | "running" | "timed_out")[] | undefined;
    agentId?: string | undefined;
    sessionKey?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
}>;
export declare const validateTasksGetParams: ValidateFunction<{
    taskId: string;
}>;
export declare const validateTasksCancelParams: ValidateFunction<{
    taskId: string;
    reason?: string | undefined;
}>;
export declare const validateConfigGetParams: ValidateFunction<object>;
export declare const validateConfigSetParams: ValidateFunction<{
    raw: string;
    baseHash?: string | undefined;
}>;
export declare const validateConfigApplyParams: ValidateFunction<{
    raw: string;
    baseHash?: string | undefined;
    sessionKey?: string | undefined;
    deliveryContext?: {
        channel?: string | undefined;
        to?: string | undefined;
        accountId?: string | undefined;
        threadId?: string | number | undefined;
    } | undefined;
    note?: string | undefined;
    restartDelayMs?: number | undefined;
}>;
export declare const validateConfigPatchParams: ValidateFunction<{
    raw: string;
    baseHash?: string | undefined;
    sessionKey?: string | undefined;
    deliveryContext?: {
        channel?: string | undefined;
        to?: string | undefined;
        accountId?: string | undefined;
        threadId?: string | number | undefined;
    } | undefined;
    note?: string | undefined;
    restartDelayMs?: number | undefined;
}>;
export declare const validateConfigSchemaParams: ValidateFunction<object>;
export declare const validateConfigSchemaLookupParams: ValidateFunction<{
    path: string;
}>;
export declare const validateConfigSchemaLookupResult: ValidateFunction<{
    path: string;
    schema: unknown;
    reloadKind?: "hot" | "none" | "restart" | undefined;
    hint?: {
        label?: string | undefined;
        help?: string | undefined;
        tags?: string[] | undefined;
        group?: string | undefined;
        order?: number | undefined;
        advanced?: boolean | undefined;
        sensitive?: boolean | undefined;
        placeholder?: string | undefined;
        itemTemplate?: unknown;
    } | undefined;
    hintPath?: string | undefined;
    children: {
        key: string;
        path: string;
        type?: string | string[] | undefined;
        required: boolean;
        hasChildren: boolean;
        reloadKind?: "hot" | "none" | "restart" | undefined;
        hint?: {
            label?: string | undefined;
            help?: string | undefined;
            tags?: string[] | undefined;
            group?: string | undefined;
            order?: number | undefined;
            advanced?: boolean | undefined;
            sensitive?: boolean | undefined;
            placeholder?: string | undefined;
            itemTemplate?: unknown;
        } | undefined;
        hintPath?: string | undefined;
    }[];
}>;
export declare const validateWizardStartParams: ValidateFunction<{
    mode?: "local" | "remote" | undefined;
    workspace?: string | undefined;
}>;
export declare const validateWizardNextParams: ValidateFunction<{
    sessionId: string;
    answer?: {
        stepId: string;
        value?: unknown;
    } | undefined;
}>;
export declare const validateWizardCancelParams: ValidateFunction<{
    sessionId: string;
}>;
export declare const validateWizardStatusParams: ValidateFunction<{
    sessionId: string;
}>;
export declare const validateTalkModeParams: ValidateFunction<{
    enabled: boolean;
    phase?: string | undefined;
}>;
export declare const validateTalkEvent: ValidateFunction<{
    id: string;
    type: "capture.cancelled" | "capture.once" | "capture.started" | "capture.stopped" | "health.changed" | "input.audio.committed" | "input.audio.delta" | "latency.metrics" | "output.audio.delta" | "output.audio.done" | "output.audio.started" | "output.text.delta" | "output.text.done" | "session.closed" | "session.error" | "session.ready" | "session.replaced" | "session.started" | "tool.call" | "tool.error" | "tool.progress" | "tool.result" | "transcript.delta" | "transcript.done" | "turn.cancelled" | "turn.ended" | "turn.started" | "usage.metrics";
    sessionId: string;
    turnId?: string | undefined;
    captureId?: string | undefined;
    seq: number;
    timestamp: string;
    mode: "realtime" | "stt-tts" | "transcription";
    transport: "gateway-relay" | "managed-room" | "provider-websocket" | "webrtc";
    brain: "agent-consult" | "direct-tools" | "none";
    provider?: string | undefined;
    final?: boolean | undefined;
    callId?: string | undefined;
    itemId?: string | undefined;
    parentId?: string | undefined;
    payload: unknown;
}>;
export declare const validateTalkCatalogParams: ValidateFunction<object>;
export declare const validateTalkCatalogResult: ValidateFunction<{
    modes: ("realtime" | "stt-tts" | "transcription")[];
    transports: ("gateway-relay" | "managed-room" | "provider-websocket" | "webrtc")[];
    brains: ("agent-consult" | "direct-tools" | "none")[];
    speech: {
        activeProvider?: string | undefined;
        providers: {
            id: string;
            label: string;
            configured: boolean;
            models?: string[] | undefined;
            voices?: string[] | undefined;
            defaultModel?: string | undefined;
            modes?: ("realtime" | "stt-tts" | "transcription")[] | undefined;
            transports?: ("gateway-relay" | "managed-room" | "provider-websocket" | "webrtc")[] | undefined;
            brains?: ("agent-consult" | "direct-tools" | "none")[] | undefined;
            inputAudioFormats?: {
                encoding: "g711_ulaw" | "pcm16";
                sampleRateHz: number;
                channels: number;
            }[] | undefined;
            outputAudioFormats?: {
                encoding: "g711_ulaw" | "pcm16";
                sampleRateHz: number;
                channels: number;
            }[] | undefined;
            supportsBrowserSession?: boolean | undefined;
            supportsBargeIn?: boolean | undefined;
            supportsToolCalls?: boolean | undefined;
            supportsVideoFrames?: boolean | undefined;
            supportsSessionResumption?: boolean | undefined;
        }[];
    };
    transcription: {
        activeProvider?: string | undefined;
        providers: {
            id: string;
            label: string;
            configured: boolean;
            models?: string[] | undefined;
            voices?: string[] | undefined;
            defaultModel?: string | undefined;
            modes?: ("realtime" | "stt-tts" | "transcription")[] | undefined;
            transports?: ("gateway-relay" | "managed-room" | "provider-websocket" | "webrtc")[] | undefined;
            brains?: ("agent-consult" | "direct-tools" | "none")[] | undefined;
            inputAudioFormats?: {
                encoding: "g711_ulaw" | "pcm16";
                sampleRateHz: number;
                channels: number;
            }[] | undefined;
            outputAudioFormats?: {
                encoding: "g711_ulaw" | "pcm16";
                sampleRateHz: number;
                channels: number;
            }[] | undefined;
            supportsBrowserSession?: boolean | undefined;
            supportsBargeIn?: boolean | undefined;
            supportsToolCalls?: boolean | undefined;
            supportsVideoFrames?: boolean | undefined;
            supportsSessionResumption?: boolean | undefined;
        }[];
    };
    realtime: {
        activeProvider?: string | undefined;
        providers: {
            id: string;
            label: string;
            configured: boolean;
            models?: string[] | undefined;
            voices?: string[] | undefined;
            defaultModel?: string | undefined;
            modes?: ("realtime" | "stt-tts" | "transcription")[] | undefined;
            transports?: ("gateway-relay" | "managed-room" | "provider-websocket" | "webrtc")[] | undefined;
            brains?: ("agent-consult" | "direct-tools" | "none")[] | undefined;
            inputAudioFormats?: {
                encoding: "g711_ulaw" | "pcm16";
                sampleRateHz: number;
                channels: number;
            }[] | undefined;
            outputAudioFormats?: {
                encoding: "g711_ulaw" | "pcm16";
                sampleRateHz: number;
                channels: number;
            }[] | undefined;
            supportsBrowserSession?: boolean | undefined;
            supportsBargeIn?: boolean | undefined;
            supportsToolCalls?: boolean | undefined;
            supportsVideoFrames?: boolean | undefined;
            supportsSessionResumption?: boolean | undefined;
        }[];
    };
}>;
export declare const validateTalkConfigParams: ValidateFunction<{
    includeSecrets?: boolean | undefined;
}>;
export declare const validateTalkConfigResult: ValidateFunction<{
    config: {
        talk?: {
            provider?: string | undefined;
            providers?: Record<string, {
                apiKey?: string | {
                    source: "env";
                    provider: string;
                    id: string;
                } | {
                    source: "file";
                    provider: string;
                    id: string;
                } | {
                    source: "exec";
                    provider: string;
                    id: string;
                } | undefined;
            }> | undefined;
            realtime?: {
                provider?: string | undefined;
                providers?: Record<string, {
                    apiKey?: string | {
                        source: "env";
                        provider: string;
                        id: string;
                    } | {
                        source: "file";
                        provider: string;
                        id: string;
                    } | {
                        source: "exec";
                        provider: string;
                        id: string;
                    } | undefined;
                }> | undefined;
                model?: string | undefined;
                voice?: string | undefined;
                instructions?: string | undefined;
                mode?: "realtime" | "stt-tts" | "transcription" | undefined;
                transport?: "gateway-relay" | "managed-room" | "provider-websocket" | "webrtc" | undefined;
                brain?: "agent-consult" | "direct-tools" | "none" | undefined;
            } | undefined;
            resolved?: {
                provider: string;
                config: {
                    apiKey?: string | {
                        source: "env";
                        provider: string;
                        id: string;
                    } | {
                        source: "file";
                        provider: string;
                        id: string;
                    } | {
                        source: "exec";
                        provider: string;
                        id: string;
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
        ui?: {
            seamColor?: string | undefined;
        } | undefined;
    };
}>;
export declare const validateTalkClientCreateParams: ValidateFunction<{
    sessionKey?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    voice?: string | undefined;
    vadThreshold?: number | undefined;
    silenceDurationMs?: number | undefined;
    prefixPaddingMs?: number | undefined;
    reasoningEffort?: string | undefined;
    mode?: "realtime" | "stt-tts" | "transcription" | undefined;
    transport?: "gateway-relay" | "managed-room" | "provider-websocket" | "webrtc" | undefined;
    brain?: "agent-consult" | "direct-tools" | "none" | undefined;
}>;
export declare const validateTalkClientCreateResult: ValidateFunction<{
    provider: string;
    transport: "webrtc";
    clientSecret: string;
    offerUrl?: string | undefined;
    offerHeaders?: Record<string, string> | undefined;
    model?: string | undefined;
    voice?: string | undefined;
    expiresAt?: number | undefined;
} | {
    provider: string;
    transport: "provider-websocket";
    protocol: string;
    clientSecret: string;
    websocketUrl: string;
    audio: {
        inputEncoding: "g711_ulaw" | "pcm16";
        inputSampleRateHz: number;
        outputEncoding: "g711_ulaw" | "pcm16";
        outputSampleRateHz: number;
    };
    initialMessage?: unknown;
    model?: string | undefined;
    voice?: string | undefined;
    expiresAt?: number | undefined;
} | {
    provider: string;
    transport: "gateway-relay";
    relaySessionId: string;
    audio: {
        inputEncoding: "g711_ulaw" | "pcm16";
        inputSampleRateHz: number;
        outputEncoding: "g711_ulaw" | "pcm16";
        outputSampleRateHz: number;
    };
    model?: string | undefined;
    voice?: string | undefined;
    expiresAt?: number | undefined;
} | {
    provider: string;
    transport: "managed-room";
    roomUrl: string;
    token?: string | undefined;
    model?: string | undefined;
    voice?: string | undefined;
    expiresAt?: number | undefined;
}>;
export declare const validateTalkClientToolCallParams: ValidateFunction<{
    sessionKey: string;
    callId: string;
    name: string;
    args?: unknown;
    relaySessionId?: string | undefined;
}>;
export declare const validateTalkClientToolCallResult: ValidateFunction<{
    runId: string;
    idempotencyKey: string;
}>;
export declare const validateTalkSessionCreateParams: ValidateFunction<{
    sessionKey?: string | undefined;
    spawnedBy?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    voice?: string | undefined;
    vadThreshold?: number | undefined;
    silenceDurationMs?: number | undefined;
    prefixPaddingMs?: number | undefined;
    reasoningEffort?: string | undefined;
    mode?: "realtime" | "stt-tts" | "transcription" | undefined;
    transport?: "gateway-relay" | "managed-room" | "provider-websocket" | "webrtc" | undefined;
    brain?: "agent-consult" | "direct-tools" | "none" | undefined;
    ttlMs?: number | undefined;
}>;
export declare const validateTalkSessionCreateResult: ValidateFunction<{
    sessionId: string;
    provider?: string | undefined;
    mode: "realtime" | "stt-tts" | "transcription";
    transport: "gateway-relay" | "managed-room" | "provider-websocket" | "webrtc";
    brain: "agent-consult" | "direct-tools" | "none";
    relaySessionId?: string | undefined;
    transcriptionSessionId?: string | undefined;
    handoffId?: string | undefined;
    roomId?: string | undefined;
    roomUrl?: string | undefined;
    token?: string | undefined;
    audio?: unknown;
    model?: string | undefined;
    voice?: string | undefined;
    expiresAt?: number | undefined;
}>;
export declare const validateTalkSessionJoinParams: ValidateFunction<{
    sessionId: string;
    token: string;
}>;
export declare const validateTalkSessionJoinResult: ValidateFunction<{
    id: string;
    roomId: string;
    roomUrl: string;
    sessionKey: string;
    sessionId?: string | undefined;
    channel?: string | undefined;
    target?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    voice?: string | undefined;
    mode: "realtime" | "stt-tts" | "transcription";
    transport: "gateway-relay" | "managed-room" | "provider-websocket" | "webrtc";
    brain: "agent-consult" | "direct-tools" | "none";
    createdAt: number;
    expiresAt: number;
    room: {
        activeClientId?: string | undefined;
        activeTurnId?: string | undefined;
        recentTalkEvents: {
            id: string;
            type: "capture.cancelled" | "capture.once" | "capture.started" | "capture.stopped" | "health.changed" | "input.audio.committed" | "input.audio.delta" | "latency.metrics" | "output.audio.delta" | "output.audio.done" | "output.audio.started" | "output.text.delta" | "output.text.done" | "session.closed" | "session.error" | "session.ready" | "session.replaced" | "session.started" | "tool.call" | "tool.error" | "tool.progress" | "tool.result" | "transcript.delta" | "transcript.done" | "turn.cancelled" | "turn.ended" | "turn.started" | "usage.metrics";
            sessionId: string;
            turnId?: string | undefined;
            captureId?: string | undefined;
            seq: number;
            timestamp: string;
            mode: "realtime" | "stt-tts" | "transcription";
            transport: "gateway-relay" | "managed-room" | "provider-websocket" | "webrtc";
            brain: "agent-consult" | "direct-tools" | "none";
            provider?: string | undefined;
            final?: boolean | undefined;
            callId?: string | undefined;
            itemId?: string | undefined;
            parentId?: string | undefined;
            payload: unknown;
        }[];
    };
}>;
export declare const validateTalkSessionAppendAudioParams: ValidateFunction<{
    sessionId: string;
    audioBase64: string;
    timestamp?: number | undefined;
}>;
export declare const validateTalkSessionTurnParams: ValidateFunction<{
    sessionId: string;
    turnId?: string | undefined;
}>;
export declare const validateTalkSessionCancelTurnParams: ValidateFunction<{
    sessionId: string;
    turnId?: string | undefined;
    reason?: string | undefined;
}>;
export declare const validateTalkSessionCancelOutputParams: ValidateFunction<{
    sessionId: string;
    turnId?: string | undefined;
    reason?: string | undefined;
}>;
export declare const validateTalkSessionTurnResult: ValidateFunction<{
    ok: boolean;
    turnId?: string | undefined;
    events?: {
        id: string;
        type: "capture.cancelled" | "capture.once" | "capture.started" | "capture.stopped" | "health.changed" | "input.audio.committed" | "input.audio.delta" | "latency.metrics" | "output.audio.delta" | "output.audio.done" | "output.audio.started" | "output.text.delta" | "output.text.done" | "session.closed" | "session.error" | "session.ready" | "session.replaced" | "session.started" | "tool.call" | "tool.error" | "tool.progress" | "tool.result" | "transcript.delta" | "transcript.done" | "turn.cancelled" | "turn.ended" | "turn.started" | "usage.metrics";
        sessionId: string;
        turnId?: string | undefined;
        captureId?: string | undefined;
        seq: number;
        timestamp: string;
        mode: "realtime" | "stt-tts" | "transcription";
        transport: "gateway-relay" | "managed-room" | "provider-websocket" | "webrtc";
        brain: "agent-consult" | "direct-tools" | "none";
        provider?: string | undefined;
        final?: boolean | undefined;
        callId?: string | undefined;
        itemId?: string | undefined;
        parentId?: string | undefined;
        payload: unknown;
    }[] | undefined;
}>;
export declare const validateTalkSessionSubmitToolResultParams: ValidateFunction<{
    sessionId: string;
    callId: string;
    result: unknown;
    options?: {
        suppressResponse?: boolean | undefined;
        willContinue?: boolean | undefined;
    } | undefined;
}>;
export declare const validateTalkSessionCloseParams: ValidateFunction<{
    sessionId: string;
}>;
export declare const validateTalkSessionOkResult: ValidateFunction<{
    ok: boolean;
}>;
export declare const validateTalkSpeakParams: ValidateFunction<{
    text: string;
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
}>;
export declare const validateTalkSpeakResult: ValidateFunction<{
    audioBase64: string;
    provider: string;
    outputFormat?: string | undefined;
    voiceCompatible?: boolean | undefined;
    mimeType?: string | undefined;
    fileExtension?: string | undefined;
}>;
export declare const validateChannelsStatusParams: ValidateFunction<{
    probe?: boolean | undefined;
    timeoutMs?: number | undefined;
    channel?: string | undefined;
}>;
export declare const validateChannelsStartParams: ValidateFunction<{
    channel: string;
    accountId?: string | undefined;
}>;
export declare const validateChannelsStopParams: ValidateFunction<{
    channel: string;
    accountId?: string | undefined;
}>;
export declare const validateChannelsLogoutParams: ValidateFunction<{
    channel: string;
    accountId?: string | undefined;
}>;
export declare const validateModelsListParams: ValidateFunction<{
    view?: "all" | "configured" | "default" | undefined;
}>;
export declare const validateSkillsStatusParams: ValidateFunction<{
    agentId?: string | undefined;
}>;
export declare const validateToolsCatalogParams: ValidateFunction<{
    agentId?: string | undefined;
    includePlugins?: boolean | undefined;
}>;
export declare const validateToolsEffectiveParams: ValidateFunction<{
    agentId?: string | undefined;
    sessionKey: string;
}>;
export declare const validateToolsInvokeParams: ValidateFunction<{
    name: string;
    args?: Record<string, unknown> | undefined;
    sessionKey?: string | undefined;
    agentId?: string | undefined;
    confirm?: boolean | undefined;
    idempotencyKey?: string | undefined;
}>;
export declare const validateSkillsBinsParams: ValidateFunction<object>;
export declare const validateSkillsInstallParams: ValidateFunction<{
    name: string;
    installId: string;
    dangerouslyForceUnsafeInstall?: boolean | undefined;
    timeoutMs?: number | undefined;
} | {
    source: "clawhub";
    slug: string;
    version?: string | undefined;
    force?: boolean | undefined;
    timeoutMs?: number | undefined;
} | {
    source: "upload";
    uploadId: string;
    slug: string;
    force?: boolean | undefined;
    sha256?: string | undefined;
    timeoutMs?: number | undefined;
}>;
export declare const validateSkillsUploadBeginParams: ValidateFunction<{
    kind: "skill-archive";
    slug: string;
    sizeBytes: number;
    sha256?: string | undefined;
    force?: boolean | undefined;
    idempotencyKey?: string | undefined;
}>;
export declare const validateSkillsUploadChunkParams: ValidateFunction<{
    uploadId: string;
    offset: number;
    dataBase64: string;
}>;
export declare const validateSkillsUploadCommitParams: ValidateFunction<{
    uploadId: string;
    sha256?: string | undefined;
}>;
export declare const validateSkillsUpdateParams: ValidateFunction<{
    skillKey: string;
    enabled?: boolean | undefined;
    apiKey?: string | undefined;
    env?: Record<string, string> | undefined;
} | {
    source: "clawhub";
    slug?: string | undefined;
    all?: boolean | undefined;
}>;
export declare const validateSkillsSearchParams: ValidateFunction<{
    query?: string | undefined;
    limit?: number | undefined;
}>;
export declare const validateSkillsDetailParams: ValidateFunction<{
    slug: string;
}>;
export declare const validateCronListParams: ValidateFunction<{
    includeDisabled?: boolean | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    query?: string | undefined;
    enabled?: "all" | "disabled" | "enabled" | undefined;
    sortBy?: "name" | "nextRunAtMs" | "updatedAtMs" | undefined;
    sortDir?: "asc" | "desc" | undefined;
    agentId?: string | undefined;
}>;
export declare const validateCronStatusParams: ValidateFunction<object>;
export declare const validateCronGetParams: ValidateFunction<{
    id: string;
} | {
    jobId: string;
}>;
export declare const validateCronAddParams: ValidateFunction<{
    agentId?: string | null | undefined;
    sessionKey?: string | null | undefined;
    description?: string | undefined;
    enabled?: boolean | undefined;
    deleteAfterRun?: boolean | undefined;
    name: string;
    schedule: {
        kind: "at";
        at: string;
    } | {
        kind: "every";
        everyMs: number;
        anchorMs?: number | undefined;
    } | {
        kind: "cron";
        expr: string;
        tz?: string | undefined;
        staggerMs?: number | undefined;
    };
    sessionTarget: string;
    wakeMode: "next-heartbeat" | "now";
    payload: {
        kind: "systemEvent";
        text: string;
    } | {
        kind: "agentTurn";
        message: unknown;
        model?: string | undefined;
        fallbacks?: string[] | undefined;
        thinking?: string | undefined;
        timeoutSeconds?: number | undefined;
        allowUnsafeExternalContent?: boolean | undefined;
        lightContext?: boolean | undefined;
        toolsAllow?: unknown;
    };
    delivery?: {
        channel?: string | undefined;
        threadId?: string | number | undefined;
        accountId?: string | undefined;
        bestEffort?: boolean | undefined;
        failureDestination?: {
            channel?: string | undefined;
            to?: string | undefined;
            accountId?: string | undefined;
            mode?: "announce" | "webhook" | undefined;
        } | undefined;
        mode: "none";
        to?: string | undefined;
    } | {
        channel?: string | undefined;
        threadId?: string | number | undefined;
        accountId?: string | undefined;
        bestEffort?: boolean | undefined;
        failureDestination?: {
            channel?: string | undefined;
            to?: string | undefined;
            accountId?: string | undefined;
            mode?: "announce" | "webhook" | undefined;
        } | undefined;
        mode: "announce";
        to?: string | undefined;
    } | {
        channel?: string | undefined;
        threadId?: string | number | undefined;
        accountId?: string | undefined;
        bestEffort?: boolean | undefined;
        failureDestination?: {
            channel?: string | undefined;
            to?: string | undefined;
            accountId?: string | undefined;
            mode?: "announce" | "webhook" | undefined;
        } | undefined;
        mode: "webhook";
        to: string;
    } | undefined;
    failureAlert?: false | {
        after?: number | undefined;
        channel?: string | undefined;
        to?: string | undefined;
        cooldownMs?: number | undefined;
        includeSkipped?: boolean | undefined;
        mode?: "announce" | "webhook" | undefined;
        accountId?: string | undefined;
    } | undefined;
}>;
export declare const validateCronUpdateParams: ValidateFunction<{
    id: string;
} | {
    jobId: string;
}>;
export declare const validateCronRemoveParams: ValidateFunction<{
    id: string;
} | {
    jobId: string;
}>;
export declare const validateCronRunParams: ValidateFunction<{
    id: string;
} | {
    jobId: string;
}>;
export declare const validateCronRunsParams: ValidateFunction<{
    scope?: "all" | "job" | undefined;
    id?: string | undefined;
    jobId?: string | undefined;
    runId?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    statuses?: ("error" | "ok" | "skipped")[] | undefined;
    status?: "all" | "error" | "ok" | "skipped" | undefined;
    deliveryStatuses?: ("delivered" | "not-delivered" | "not-requested" | "unknown")[] | undefined;
    deliveryStatus?: "delivered" | "not-delivered" | "not-requested" | "unknown" | undefined;
    query?: string | undefined;
    sortDir?: "asc" | "desc" | undefined;
}>;
export declare const validateDevicePairListParams: ValidateFunction<object>;
export declare const validateDevicePairApproveParams: ValidateFunction<{
    requestId: string;
}>;
export declare const validateDevicePairRejectParams: ValidateFunction<{
    requestId: string;
}>;
export declare const validateDevicePairRemoveParams: ValidateFunction<{
    deviceId: string;
}>;
export declare const validateDeviceTokenRotateParams: ValidateFunction<{
    deviceId: string;
    role: string;
    scopes?: string[] | undefined;
}>;
export declare const validateDeviceTokenRevokeParams: ValidateFunction<{
    deviceId: string;
    role: string;
}>;
export declare const validateExecApprovalsGetParams: ValidateFunction<object>;
export declare const validateExecApprovalsSetParams: ValidateFunction<{
    file: {
        version: 1;
        socket?: {
            path?: string | undefined;
            token?: string | undefined;
        } | undefined;
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
                pattern: string;
                source?: "allow-always" | undefined;
                commandText?: string | undefined;
                argPattern?: string | undefined;
                lastUsedAt?: number | undefined;
                lastUsedCommand?: string | undefined;
                lastResolvedPath?: string | undefined;
            }[] | undefined;
        }> | undefined;
    };
    baseHash?: string | undefined;
}>;
export declare const validateExecApprovalGetParams: ValidateFunction<{
    id: string;
}>;
export declare const validateExecApprovalRequestParams: ValidateFunction<{
    id?: string | undefined;
    command?: string | undefined;
    commandArgv?: string[] | undefined;
    systemRunPlan?: {
        argv: string[];
        cwd: string | null;
        commandText: string;
        commandPreview?: string | null | undefined;
        agentId: string | null;
        sessionKey: string | null;
        mutableFileOperand?: {
            argvIndex: number;
            path: string;
            sha256: string;
        } | null | undefined;
    } | undefined;
    env?: Record<string, string> | undefined;
    cwd?: string | null | undefined;
    nodeId?: string | null | undefined;
    host?: string | null | undefined;
    security?: string | null | undefined;
    ask?: string | null | undefined;
    warningText?: string | null | undefined;
    commandSpans?: {
        startIndex: number;
        endIndex: number;
    }[] | undefined;
    agentId?: string | null | undefined;
    resolvedPath?: string | null | undefined;
    sessionKey?: string | null | undefined;
    turnSourceChannel?: string | null | undefined;
    turnSourceTo?: string | null | undefined;
    turnSourceAccountId?: string | null | undefined;
    turnSourceThreadId?: string | number | null | undefined;
    timeoutMs?: number | undefined;
    twoPhase?: boolean | undefined;
}>;
export declare const validateExecApprovalResolveParams: ValidateFunction<{
    id: string;
    decision: string;
}>;
export declare const validatePluginApprovalRequestParams: ValidateFunction<{
    pluginId?: string | undefined;
    title: string;
    description: string;
    severity?: string | undefined;
    toolName?: string | undefined;
    toolCallId?: string | undefined;
    allowedDecisions?: string[] | undefined;
    agentId?: string | undefined;
    sessionKey?: string | undefined;
    turnSourceChannel?: string | undefined;
    turnSourceTo?: string | undefined;
    turnSourceAccountId?: string | undefined;
    turnSourceThreadId?: string | number | undefined;
    timeoutMs?: number | undefined;
    twoPhase?: boolean | undefined;
}>;
export declare const validatePluginApprovalResolveParams: ValidateFunction<{
    id: string;
    decision: string;
}>;
export declare const validatePluginsUiDescriptorsParams: ValidateFunction<object>;
export declare const validatePluginsSessionActionParams: ValidateFunction<{
    pluginId: string;
    actionId: string;
    sessionKey?: string | undefined;
    payload?: unknown;
}>;
export declare const validatePluginsSessionActionResult: ValidateFunction<{
    ok: true;
    result?: unknown;
    continueAgent?: boolean | undefined;
    reply?: unknown;
} | {
    ok: false;
    error: string;
    code?: string | undefined;
    details?: unknown;
}>;
export declare const validateExecApprovalsNodeGetParams: ValidateFunction<{
    nodeId: string;
}>;
export declare const validateExecApprovalsNodeSetParams: ValidateFunction<{
    nodeId: string;
    file: {
        version: 1;
        socket?: {
            path?: string | undefined;
            token?: string | undefined;
        } | undefined;
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
                pattern: string;
                source?: "allow-always" | undefined;
                commandText?: string | undefined;
                argPattern?: string | undefined;
                lastUsedAt?: number | undefined;
                lastUsedCommand?: string | undefined;
                lastResolvedPath?: string | undefined;
            }[] | undefined;
        }> | undefined;
    };
    baseHash?: string | undefined;
}>;
export declare const validateLogsTailParams: ValidateFunction<{
    cursor?: number | undefined;
    limit?: number | undefined;
    maxBytes?: number | undefined;
}>;
export declare const validateChatHistoryParams: ValidateFunction<unknown>;
export declare const validateChatSendParams: ValidateFunction<unknown>;
export declare const validateChatAbortParams: ValidateFunction<{
    sessionKey: string;
    runId?: string | undefined;
}>;
export declare const validateChatInjectParams: ValidateFunction<{
    sessionKey: string;
    message: string;
    label?: string | undefined;
}>;
export declare const validateChatEvent: ValidateFunction<unknown>;
export declare const validateUpdateStatusParams: ValidateFunction<object>;
export declare const validateUpdateRunParams: ValidateFunction<{
    sessionKey?: string | undefined;
    deliveryContext?: {
        channel?: string | undefined;
        to?: string | undefined;
        accountId?: string | undefined;
        threadId?: string | number | undefined;
    } | undefined;
    note?: string | undefined;
    continuationMessage?: string | undefined;
    restartDelayMs?: number | undefined;
    timeoutMs?: number | undefined;
}>;
export declare const validateWebLoginStartParams: ValidateFunction<{
    force?: boolean | undefined;
    timeoutMs?: number | undefined;
    verbose?: boolean | undefined;
    accountId?: string | undefined;
}>;
export declare const validateWebLoginWaitParams: ValidateFunction<{
    timeoutMs?: number | undefined;
    accountId?: string | undefined;
    currentQrDataUrl?: string | undefined;
}>;
export declare function formatValidationErrors(errors: ErrorObject[] | null | undefined): string;
export { ConnectParamsSchema, HelloOkSchema, RequestFrameSchema, ResponseFrameSchema, EventFrameSchema, GatewayFrameSchema, PresenceEntrySchema, SnapshotSchema, ErrorShapeSchema, EnvironmentStatusSchema, EnvironmentSummarySchema, EnvironmentsListParamsSchema, EnvironmentsListResultSchema, EnvironmentsStatusParamsSchema, EnvironmentsStatusResultSchema, StateVersionSchema, AgentEventSchema, MessageActionParamsSchema, ChatEventSchema, SendParamsSchema, PollParamsSchema, AgentParamsSchema, AgentIdentityParamsSchema, AgentIdentityResultSchema, WakeParamsSchema, PushTestParamsSchema, PushTestResultSchema, WebPushVapidPublicKeyParamsSchema, WebPushSubscribeParamsSchema, WebPushUnsubscribeParamsSchema, WebPushTestParamsSchema, NodePairRequestParamsSchema, NodePairListParamsSchema, NodePairApproveParamsSchema, NodePairRejectParamsSchema, NodePairRemoveParamsSchema, NodePairVerifyParamsSchema, NodeListParamsSchema, NodePendingAckParamsSchema, NodeInvokeParamsSchema, NodeEventResultSchema, NodePresenceAlivePayloadSchema, NodePresenceAliveReasonSchema, NodePendingDrainParamsSchema, NodePendingDrainResultSchema, NodePendingEnqueueParamsSchema, NodePendingEnqueueResultSchema, SessionsListParamsSchema, SessionsCleanupParamsSchema, SessionsPreviewParamsSchema, SessionsDescribeParamsSchema, SessionsResolveParamsSchema, SessionsCompactionListParamsSchema, SessionsCompactionGetParamsSchema, SessionsCompactionBranchParamsSchema, SessionsCompactionRestoreParamsSchema, SessionsCreateParamsSchema, SessionsSendParamsSchema, SessionsAbortParamsSchema, SessionsPatchParamsSchema, SessionsPluginPatchParamsSchema, SessionsResetParamsSchema, SessionsDeleteParamsSchema, SessionsCompactParamsSchema, SessionsUsageParamsSchema, ArtifactSummarySchema, ArtifactsListParamsSchema, ArtifactsGetParamsSchema, ArtifactsDownloadParamsSchema, TaskSummarySchema, TasksListParamsSchema, TasksListResultSchema, TasksGetParamsSchema, TasksGetResultSchema, TasksCancelParamsSchema, TasksCancelResultSchema, ConfigGetParamsSchema, ConfigSetParamsSchema, ConfigApplyParamsSchema, ConfigPatchParamsSchema, ConfigSchemaParamsSchema, ConfigSchemaLookupParamsSchema, ConfigSchemaResponseSchema, ConfigSchemaLookupResultSchema, UpdateStatusParamsSchema, WizardStartParamsSchema, WizardNextParamsSchema, WizardCancelParamsSchema, WizardStatusParamsSchema, WizardStepSchema, WizardNextResultSchema, WizardStartResultSchema, WizardStatusResultSchema, TalkEventSchema, TalkCatalogParamsSchema, TalkCatalogResultSchema, TalkClientCreateParamsSchema, TalkClientCreateResultSchema, TalkClientToolCallParamsSchema, TalkClientToolCallResultSchema, TalkConfigParamsSchema, TalkConfigResultSchema, TalkSessionAppendAudioParamsSchema, TalkSessionCancelOutputParamsSchema, TalkSessionCancelTurnParamsSchema, TalkSessionCreateParamsSchema, TalkSessionCreateResultSchema, TalkSessionJoinParamsSchema, TalkSessionJoinResultSchema, TalkSessionTurnParamsSchema, TalkSessionTurnResultSchema, TalkSessionSubmitToolResultParamsSchema, TalkSessionCloseParamsSchema, TalkSessionOkResultSchema, TalkSpeakParamsSchema, TalkSpeakResultSchema, ChannelsStatusParamsSchema, ChannelsStatusResultSchema, ChannelsStartParamsSchema, ChannelsStopParamsSchema, ChannelsLogoutParamsSchema, WebLoginStartParamsSchema, WebLoginWaitParamsSchema, AgentSummarySchema, AgentsFileEntrySchema, AgentsCreateParamsSchema, AgentsCreateResultSchema, AgentsUpdateParamsSchema, AgentsUpdateResultSchema, AgentsDeleteParamsSchema, AgentsDeleteResultSchema, AgentsFilesListParamsSchema, AgentsFilesListResultSchema, AgentsFilesGetParamsSchema, AgentsFilesGetResultSchema, AgentsFilesSetParamsSchema, AgentsFilesSetResultSchema, AgentsListParamsSchema, AgentsListResultSchema, CommandsListParamsSchema, CommandsListResultSchema, PluginsSessionActionParamsSchema, PluginsSessionActionResultSchema, PluginsUiDescriptorsParamsSchema, ModelsListParamsSchema, SkillsStatusParamsSchema, ToolsCatalogParamsSchema, ToolsEffectiveParamsSchema, ToolsInvokeParamsSchema, SkillsInstallParamsSchema, SkillsSearchParamsSchema, SkillsSearchResultSchema, SkillsDetailParamsSchema, SkillsDetailResultSchema, SkillsUploadBeginParamsSchema, SkillsUploadChunkParamsSchema, SkillsUploadCommitParamsSchema, SkillsUpdateParamsSchema, CronJobSchema, CronListParamsSchema, CronStatusParamsSchema, CronGetParamsSchema, CronAddParamsSchema, CronUpdateParamsSchema, CronRemoveParamsSchema, CronRunParamsSchema, CronRunsParamsSchema, LogsTailParamsSchema, LogsTailResultSchema, ExecApprovalsGetParamsSchema, ExecApprovalsSetParamsSchema, ExecApprovalGetParamsSchema, ExecApprovalRequestParamsSchema, ExecApprovalResolveParamsSchema, ChatHistoryParamsSchema, ChatSendParamsSchema, ChatInjectParamsSchema, UpdateRunParamsSchema, TickEventSchema, ShutdownEventSchema, ProtocolSchemas, MIN_CLIENT_PROTOCOL_VERSION, MIN_PROBE_PROTOCOL_VERSION, PROTOCOL_VERSION, ErrorCodes, errorShape, };
export type { GatewayFrame, ConnectParams, HelloOk, RequestFrame, ResponseFrame, EventFrame, PresenceEntry, Snapshot, ErrorShape, StateVersion, AgentEvent, AgentIdentityParams, AgentIdentityResult, AgentWaitParams, ChatEvent, TickEvent, ShutdownEvent, WakeParams, NodePairRequestParams, NodePairListParams, NodePairApproveParams, DevicePairListParams, DevicePairApproveParams, DevicePairRejectParams, ConfigGetParams, ConfigSetParams, ConfigApplyParams, ConfigPatchParams, ConfigSchemaParams, ConfigSchemaResponse, WizardStartParams, WizardNextParams, WizardCancelParams, WizardStatusParams, WizardStep, WizardNextResult, WizardStartResult, WizardStatusResult, TalkCatalogParams, TalkCatalogResult, TalkClientCreateParams, TalkClientCreateResult, TalkClientToolCallParams, TalkClientToolCallResult, TalkConfigParams, TalkConfigResult, TalkSessionAppendAudioParams, TalkSessionCancelOutputParams, TalkSessionCancelTurnParams, TalkSessionCreateParams, TalkSessionCreateResult, TalkSessionJoinParams, TalkSessionJoinResult, TalkSessionTurnParams, TalkSessionTurnResult, TalkSessionSubmitToolResultParams, TalkSessionCloseParams, TalkSessionOkResult, TalkSpeakParams, TalkSpeakResult, TalkModeParams, ChannelsStatusParams, ChannelsStatusResult, ChannelsStartParams, ChannelsStopParams, ChannelsLogoutParams, WebLoginStartParams, WebLoginWaitParams, AgentSummary, AgentsFileEntry, AgentsCreateParams, AgentsCreateResult, AgentsUpdateParams, AgentsUpdateResult, AgentsDeleteParams, AgentsDeleteResult, AgentsFilesListParams, AgentsFilesListResult, AgentsFilesGetParams, AgentsFilesGetResult, AgentsFilesSetParams, AgentsFilesSetResult, ArtifactSummary, ArtifactsListParams, ArtifactsListResult, ArtifactsGetParams, ArtifactsGetResult, ArtifactsDownloadParams, ArtifactsDownloadResult, AgentsListParams, AgentsListResult, CommandsListParams, CommandsListResult, CommandEntry, PluginsSessionActionParams, PluginsSessionActionResult, SkillsStatusParams, ToolsCatalogParams, ToolsCatalogResult, ToolsEffectiveParams, ToolsEffectiveResult, ToolsInvokeParams, ToolsInvokeResult, SkillsBinsParams, SkillsBinsResult, SkillsSearchParams, SkillsSearchResult, SkillsDetailParams, SkillsDetailResult, SkillsUploadBeginParams, SkillsUploadChunkParams, SkillsUploadCommitParams, SkillsInstallParams, SkillsUpdateParams, EnvironmentStatus, EnvironmentSummary, EnvironmentsListParams, EnvironmentsListResult, EnvironmentsStatusParams, EnvironmentsStatusResult, NodePairRejectParams, NodePairRemoveParams, NodePairVerifyParams, NodeListParams, NodeInvokeParams, NodeInvokeResultParams, NodeEventParams, NodeEventResult, NodePresenceAlivePayload, NodePresenceAliveReason, NodePendingDrainParams, NodePendingDrainResult, NodePendingEnqueueParams, NodePendingEnqueueResult, SessionsListParams, SessionsCleanupParams, SessionsPreviewParams, SessionsDescribeParams, SessionsResolveParams, SessionOperationEvent, SessionsPatchParams, SessionsPatchResult, SessionsResetParams, SessionsDeleteParams, SessionsCompactParams, SessionsUsageParams, TaskSummary, TasksListParams, TasksListResult, TasksGetParams, TasksGetResult, TasksCancelParams, TasksCancelResult, CronJob, CronListParams, CronStatusParams, CronGetParams, CronAddParams, CronUpdateParams, CronRemoveParams, CronRunParams, CronRunsParams, CronRunLogEntry, ExecApprovalsGetParams, ExecApprovalsSetParams, ExecApprovalsSnapshot, ExecApprovalGetParams, ExecApprovalRequestParams, ExecApprovalResolveParams, LogsTailParams, LogsTailResult, PollParams, WebPushVapidPublicKeyParams, WebPushSubscribeParams, WebPushUnsubscribeParams, WebPushTestParams, UpdateStatusParams, UpdateRunParams, ChatInjectParams, };
