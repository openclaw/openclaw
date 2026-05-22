import AjvPkg, { type ErrorObject } from "ajv";
import type { SessionsPatchResult } from "../session-utils.types.js";
import { type AgentEvent, AgentEventSchema, type AgentIdentityParams, AgentIdentityParamsSchema, type AgentIdentityResult, AgentIdentityResultSchema, AgentParamsSchema, MessageActionParamsSchema, type AgentSummary, AgentSummarySchema, type AgentsFileEntry, AgentsFileEntrySchema, type AgentsCreateParams, AgentsCreateParamsSchema, type AgentsCreateResult, AgentsCreateResultSchema, type AgentsUpdateParams, AgentsUpdateParamsSchema, type AgentsUpdateResult, AgentsUpdateResultSchema, type AgentsDeleteParams, AgentsDeleteParamsSchema, type AgentsDeleteResult, AgentsDeleteResultSchema, type AgentsFilesGetParams, AgentsFilesGetParamsSchema, type AgentsFilesGetResult, AgentsFilesGetResultSchema, type AgentsFilesListParams, AgentsFilesListParamsSchema, type AgentsFilesListResult, AgentsFilesListResultSchema, type AgentsFilesSetParams, AgentsFilesSetParamsSchema, type AgentsFilesSetResult, AgentsFilesSetResultSchema, type ArtifactsDownloadParams, ArtifactsDownloadParamsSchema, type ArtifactsDownloadResult, type ArtifactsGetParams, ArtifactsGetParamsSchema, type ArtifactsGetResult, type ArtifactsListParams, ArtifactsListParamsSchema, type ArtifactsListResult, type ArtifactSummary, ArtifactSummarySchema, type AgentsListParams, AgentsListParamsSchema, type AgentsListResult, AgentsListResultSchema, type AgentWaitParams, type ChannelsStartParams, ChannelsStartParamsSchema, type ChannelsStopParams, ChannelsStopParamsSchema, type ChannelsLogoutParams, ChannelsLogoutParamsSchema, type TalkConfigParams, TalkConfigParamsSchema, type TalkConfigResult, TalkConfigResultSchema, type TalkRealtimeRelayAudioParams, TalkRealtimeRelayAudioParamsSchema, type TalkRealtimeRelayMarkParams, TalkRealtimeRelayMarkParamsSchema, type TalkRealtimeRelayOkResult, TalkRealtimeRelayOkResultSchema, type TalkRealtimeRelayStopParams, TalkRealtimeRelayStopParamsSchema, type TalkRealtimeRelayToolResultParams, TalkRealtimeRelayToolResultParamsSchema, type TalkRealtimeSessionParams, TalkRealtimeSessionParamsSchema, type TalkRealtimeSessionResult, TalkRealtimeSessionResultSchema, type TalkSpeakParams, TalkSpeakParamsSchema, type TalkSpeakResult, TalkSpeakResultSchema, type ChannelsStatusParams, ChannelsStatusParamsSchema, type ChannelsStatusResult, ChannelsStatusResultSchema, type CommandEntry, type CommandsListParams, CommandsListParamsSchema, type CommandsListResult, CommandsListResultSchema, type ChatEvent, ChatEventSchema, ChatHistoryParamsSchema, type ChatInjectParams, ChatInjectParamsSchema, ChatSendParamsSchema, type ConfigApplyParams, ConfigApplyParamsSchema, type ConfigGetParams, ConfigGetParamsSchema, type ConfigPatchParams, ConfigPatchParamsSchema, ConfigSchemaLookupParamsSchema, ConfigSchemaLookupResultSchema, type ConfigSchemaParams, ConfigSchemaParamsSchema, type ConfigSchemaResponse, ConfigSchemaResponseSchema, type ConfigSetParams, ConfigSetParamsSchema, type UpdateStatusParams, UpdateStatusParamsSchema, type ConnectParams, ConnectParamsSchema, type CronAddParams, CronAddParamsSchema, type CronJob, CronJobSchema, type CronListParams, CronListParamsSchema, type CronRemoveParams, CronRemoveParamsSchema, type CronRunLogEntry, type CronRunParams, CronRunParamsSchema, type CronRunsParams, CronRunsParamsSchema, type CronStatusParams, CronStatusParamsSchema, type CronUpdateParams, CronUpdateParamsSchema, type DevicePairApproveParams, type DevicePairListParams, type DevicePairRejectParams, type ExecApprovalsGetParams, ExecApprovalsGetParamsSchema, type ExecApprovalsSetParams, ExecApprovalsSetParamsSchema, type ExecApprovalsSnapshot, type ExecApprovalGetParams, ExecApprovalGetParamsSchema, type ExecApprovalRequestParams, ExecApprovalRequestParamsSchema, type ExecApprovalResolveParams, ExecApprovalResolveParamsSchema, PluginsUiDescriptorsParamsSchema, ErrorCodes, type ErrorShape, ErrorShapeSchema, type EventFrame, EventFrameSchema, errorShape, type GatewayFrame, GatewayFrameSchema, type HelloOk, HelloOkSchema, type LogsTailParams, LogsTailParamsSchema, type LogsTailResult, LogsTailResultSchema, ModelsListParamsSchema, type NodeEventParams, type NodeEventResult, NodeEventResultSchema, type NodePendingDrainParams, NodePendingDrainParamsSchema, type NodePendingDrainResult, NodePendingDrainResultSchema, type NodePendingEnqueueParams, NodePendingEnqueueParamsSchema, type NodePendingEnqueueResult, NodePendingEnqueueResultSchema, type NodePresenceAlivePayload, NodePresenceAlivePayloadSchema, type NodePresenceAliveReason, NodePresenceAliveReasonSchema, type NodeInvokeParams, NodeInvokeParamsSchema, type NodeInvokeResultParams, type NodeListParams, NodeListParamsSchema, NodePendingAckParamsSchema, type NodePairApproveParams, NodePairApproveParamsSchema, type NodePairListParams, NodePairListParamsSchema, type NodePairRejectParams, NodePairRejectParamsSchema, type NodePairRemoveParams, NodePairRemoveParamsSchema, type NodePairRequestParams, NodePairRequestParamsSchema, type NodePairVerifyParams, NodePairVerifyParamsSchema, type PollParams, PollParamsSchema, PROTOCOL_VERSION, PushTestParamsSchema, PushTestResultSchema, type WebPushVapidPublicKeyParams, WebPushVapidPublicKeyParamsSchema, type WebPushSubscribeParams, WebPushSubscribeParamsSchema, type WebPushUnsubscribeParams, WebPushUnsubscribeParamsSchema, type WebPushTestParams, WebPushTestParamsSchema, type PresenceEntry, PresenceEntrySchema, ProtocolSchemas, type RequestFrame, RequestFrameSchema, type ResponseFrame, ResponseFrameSchema, SendParamsSchema, SessionsAbortParamsSchema, type SessionsCompactParams, SessionsCompactParamsSchema, type SessionsCleanupParams, SessionsCleanupParamsSchema, SessionsCompactionBranchParamsSchema, SessionsCompactionGetParamsSchema, SessionsCompactionListParamsSchema, SessionsCompactionRestoreParamsSchema, SessionsCreateParamsSchema, type SessionsDeleteParams, SessionsDeleteParamsSchema, type SessionsDescribeParams, SessionsDescribeParamsSchema, type SessionsListParams, SessionsListParamsSchema, type SessionsPatchParams, SessionsPatchParamsSchema, SessionsPluginPatchParamsSchema, type SessionsPreviewParams, SessionsPreviewParamsSchema, type SessionsResetParams, SessionsResetParamsSchema, type SessionsResolveParams, SessionsResolveParamsSchema, SessionsSendParamsSchema, type SessionsUsageParams, SessionsUsageParamsSchema, type ShutdownEvent, ShutdownEventSchema, type SkillsBinsParams, type SkillsBinsResult, type SkillsDetailParams, SkillsDetailParamsSchema, type SkillsDetailResult, SkillsDetailResultSchema, type SkillsInstallParams, SkillsInstallParamsSchema, type SkillsSearchParams, SkillsSearchParamsSchema, type SkillsSearchResult, SkillsSearchResultSchema, type SkillsStatusParams, SkillsStatusParamsSchema, type SkillsUpdateParams, SkillsUpdateParamsSchema, type ToolsCatalogParams, ToolsCatalogParamsSchema, type ToolsCatalogResult, type ToolsEffectiveParams, ToolsEffectiveParamsSchema, type ToolsEffectiveResult, type ToolsInvokeParams, ToolsInvokeParamsSchema, type ToolsInvokeResult, type Snapshot, SnapshotSchema, type StateVersion, StateVersionSchema, type TalkModeParams, type TickEvent, TickEventSchema, type UpdateRunParams, UpdateRunParamsSchema, type WakeParams, WakeParamsSchema, type WebLoginStartParams, WebLoginStartParamsSchema, type WebLoginWaitParams, WebLoginWaitParamsSchema, type WizardCancelParams, WizardCancelParamsSchema, type WizardNextParams, WizardNextParamsSchema, type WizardNextResult, WizardNextResultSchema, type WizardStartParams, WizardStartParamsSchema, type WizardStartResult, WizardStartResultSchema, type WizardStatusParams, WizardStatusParamsSchema, type WizardStatusResult, WizardStatusResultSchema, type WizardStep, WizardStepSchema } from "./schema.js";
export declare const validateCommandsListParams: AjvPkg.ValidateFunction<{
    agentId?: string | undefined;
    provider?: string | undefined;
    scope?: "both" | "native" | "text" | undefined;
    includeArgs?: boolean | undefined;
}>;
export declare const validateConnectParams: AjvPkg.ValidateFunction<{
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
    } | undefined;
    locale?: string | undefined;
    userAgent?: string | undefined;
}>;
export declare const validateRequestFrame: AjvPkg.ValidateFunction<{
    type: "req";
    id: string;
    method: string;
    params?: unknown;
}>;
export declare const validateResponseFrame: AjvPkg.ValidateFunction<{
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
export declare const validateEventFrame: AjvPkg.ValidateFunction<{
    type: "event";
    event: string;
    payload?: unknown;
    seq?: number | undefined;
    stateVersion?: {
        presence: number;
        health: number;
    } | undefined;
}>;
export declare const validateMessageActionParams: AjvPkg.ValidateFunction<{
    channel: string;
    action: string;
    params: Record<string, unknown>;
    accountId?: string | undefined;
    requesterSenderId?: string | undefined;
    senderIsOwner?: boolean | undefined;
    sessionKey?: string | undefined;
    sessionId?: string | undefined;
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
export declare const validateSendParams: AjvPkg.ValidateFunction<{
    idempotencyKey: any;
    to: any;
} & {
    idempotencyKey: any;
} & {
    to: any;
}>;
export declare const validatePollParams: AjvPkg.ValidateFunction<{
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
export declare const validateAgentParams: AjvPkg.ValidateFunction<{
    idempotencyKey: any;
    message: any;
} & {
    idempotencyKey: any;
} & {
    message: any;
}>;
export declare const validateAgentIdentityParams: AjvPkg.ValidateFunction<{
    agentId?: string | undefined;
    sessionKey?: string | undefined;
}>;
export declare const validateAgentWaitParams: AjvPkg.ValidateFunction<{
    runId: string;
    timeoutMs?: number | undefined;
}>;
export declare const validateWakeParams: AjvPkg.ValidateFunction<{
    mode: "next-heartbeat" | "now";
    text: string;
}>;
export declare const validateAgentsListParams: AjvPkg.ValidateFunction<object>;
export declare const validateAgentsCreateParams: AjvPkg.ValidateFunction<{
    name: string;
    workspace: string;
    model?: string | undefined;
    emoji?: string | undefined;
    avatar?: string | undefined;
}>;
export declare const validateAgentsUpdateParams: AjvPkg.ValidateFunction<{
    agentId: string;
    name?: string | undefined;
    workspace?: string | undefined;
    model?: string | undefined;
    emoji?: string | undefined;
    avatar?: string | undefined;
}>;
export declare const validateAgentsDeleteParams: AjvPkg.ValidateFunction<{
    agentId: string;
    deleteFiles?: boolean | undefined;
}>;
export declare const validateAgentsFilesListParams: AjvPkg.ValidateFunction<{
    agentId: string;
}>;
export declare const validateAgentsFilesGetParams: AjvPkg.ValidateFunction<{
    agentId: string;
    name: string;
}>;
export declare const validateAgentsFilesSetParams: AjvPkg.ValidateFunction<{
    agentId: string;
    name: string;
    content: string;
}>;
export declare const validateArtifactsListParams: AjvPkg.ValidateFunction<{
    sessionKey?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
}>;
export declare const validateArtifactsGetParams: AjvPkg.ValidateFunction<{
    sessionKey?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
    artifactId: string;
}>;
export declare const validateArtifactsDownloadParams: AjvPkg.ValidateFunction<{
    sessionKey?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
    artifactId: string;
}>;
export declare const validateNodePairRequestParams: AjvPkg.ValidateFunction<{
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
    remoteIp?: string | undefined;
    silent?: boolean | undefined;
}>;
export declare const validateNodePairListParams: AjvPkg.ValidateFunction<object>;
export declare const validateNodePairApproveParams: AjvPkg.ValidateFunction<{
    requestId: string;
}>;
export declare const validateNodePairRejectParams: AjvPkg.ValidateFunction<{
    requestId: string;
}>;
export declare const validateNodePairRemoveParams: AjvPkg.ValidateFunction<{
    nodeId: string;
}>;
export declare const validateNodePairVerifyParams: AjvPkg.ValidateFunction<{
    nodeId: string;
    token: string;
}>;
export declare const validateNodeRenameParams: AjvPkg.ValidateFunction<{
    nodeId: string;
    displayName: string;
}>;
export declare const validateNodeListParams: AjvPkg.ValidateFunction<object>;
export declare const validateNodePendingAckParams: AjvPkg.ValidateFunction<{
    ids: string[];
}>;
export declare const validateNodeDescribeParams: AjvPkg.ValidateFunction<{
    nodeId: string;
}>;
export declare const validateNodeInvokeParams: AjvPkg.ValidateFunction<{
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number | undefined;
    idempotencyKey: string;
}>;
export declare const validateNodeInvokeResultParams: AjvPkg.ValidateFunction<{
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
export declare const validateNodeEventParams: AjvPkg.ValidateFunction<{
    event: string;
    payload?: unknown;
    payloadJSON?: string | undefined;
}>;
export declare const validateNodeEventResult: AjvPkg.ValidateFunction<{
    ok: boolean;
    event: string;
    handled: boolean;
    reason?: string | undefined;
}>;
export declare const validateNodePresenceAlivePayload: AjvPkg.ValidateFunction<{
    trigger: string;
    sentAtMs?: number | undefined;
    displayName?: string | undefined;
    version?: string | undefined;
    platform?: string | undefined;
    deviceFamily?: string | undefined;
    modelIdentifier?: string | undefined;
    pushTransport?: string | undefined;
}>;
export declare const validateNodePendingDrainParams: AjvPkg.ValidateFunction<{
    maxItems?: number | undefined;
}>;
export declare const validateNodePendingEnqueueParams: AjvPkg.ValidateFunction<{
    nodeId: string;
    type: string;
    priority?: string | undefined;
    expiresInMs?: number | undefined;
    wake?: boolean | undefined;
}>;
export declare const validatePushTestParams: AjvPkg.ValidateFunction<{
    nodeId: string;
    title?: string | undefined;
    body?: string | undefined;
    environment?: string | undefined;
}>;
export declare const validateWebPushVapidPublicKeyParams: AjvPkg.ValidateFunction<WebPushVapidPublicKeyParams>;
export declare const validateWebPushSubscribeParams: AjvPkg.ValidateFunction<WebPushSubscribeParams>;
export declare const validateWebPushUnsubscribeParams: AjvPkg.ValidateFunction<WebPushUnsubscribeParams>;
export declare const validateWebPushTestParams: AjvPkg.ValidateFunction<WebPushTestParams>;
export declare const validateSecretsResolveParams: AjvPkg.ValidateFunction<{
    commandName: string;
    targetIds: string[];
}>;
export declare const validateSecretsResolveResult: AjvPkg.ValidateFunction<{
    ok?: boolean | undefined;
    assignments?: {
        path?: string | undefined;
        pathSegments: string[];
        value: unknown;
    }[] | undefined;
    diagnostics?: string[] | undefined;
    inactiveRefPaths?: string[] | undefined;
}>;
export declare const validateSessionsListParams: AjvPkg.ValidateFunction<{
    limit?: number | undefined;
    activeMinutes?: number | undefined;
    includeGlobal?: boolean | undefined;
    includeUnknown?: boolean | undefined;
    includeDerivedTitles?: boolean | undefined;
    includeLastMessage?: boolean | undefined;
    label?: string | undefined;
    spawnedBy?: string | undefined;
    agentId?: string | undefined;
    search?: string | undefined;
}>;
export declare const validateSessionsCleanupParams: AjvPkg.ValidateFunction<{
    agent?: string | undefined;
    allAgents?: boolean | undefined;
    enforce?: boolean | undefined;
    activeKey?: string | undefined;
    fixMissing?: boolean | undefined;
}>;
export declare const validateSessionsPreviewParams: AjvPkg.ValidateFunction<{
    keys: string[];
    limit?: number | undefined;
    maxChars?: number | undefined;
}>;
export declare const validateSessionsDescribeParams: AjvPkg.ValidateFunction<{
    key: string;
    includeDerivedTitles?: boolean | undefined;
    includeLastMessage?: boolean | undefined;
}>;
export declare const validateSessionsResolveParams: AjvPkg.ValidateFunction<{
    key?: string | undefined;
    sessionId?: string | undefined;
    label?: string | undefined;
    agentId?: string | undefined;
    spawnedBy?: string | undefined;
    includeGlobal?: boolean | undefined;
    includeUnknown?: boolean | undefined;
}>;
export declare const validateSessionsCreateParams: AjvPkg.ValidateFunction<{
    key?: string | undefined;
    agentId?: string | undefined;
    label?: string | undefined;
    model?: string | undefined;
    parentSessionKey?: string | undefined;
    emitCommandHooks?: boolean | undefined;
    task?: string | undefined;
    message?: string | undefined;
}>;
export declare const validateSessionsSendParams: AjvPkg.ValidateFunction<{
    key: string;
    message: string;
    thinking?: string | undefined;
    attachments?: unknown[] | undefined;
    timeoutMs?: number | undefined;
    idempotencyKey?: string | undefined;
}>;
export declare const validateSessionsMessagesSubscribeParams: AjvPkg.ValidateFunction<{
    key: string;
}>;
export declare const validateSessionsMessagesUnsubscribeParams: AjvPkg.ValidateFunction<{
    key: string;
}>;
export declare const validateSessionsAbortParams: AjvPkg.ValidateFunction<{
    key?: string | undefined;
    runId?: string | undefined;
}>;
export declare const validateSessionsPatchParams: AjvPkg.ValidateFunction<{
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
    sendPolicy?: "allow" | "deny" | null | undefined;
    groupActivation?: "always" | "mention" | null | undefined;
}>;
export declare const validateSessionsPluginPatchParams: AjvPkg.ValidateFunction<{
    key: string;
    pluginId: string;
    namespace: string;
    value?: unknown;
    unset?: boolean | undefined;
}>;
export declare const validateSessionsResetParams: AjvPkg.ValidateFunction<{
    key: string;
    reason?: "new" | "reset" | undefined;
}>;
export declare const validateSessionsDeleteParams: AjvPkg.ValidateFunction<{
    key: string;
    deleteTranscript?: boolean | undefined;
    emitLifecycleHooks?: boolean | undefined;
}>;
export declare const validateSessionsCompactParams: AjvPkg.ValidateFunction<{
    key: string;
    maxLines?: number | undefined;
}>;
export declare const validateSessionsCompactionListParams: AjvPkg.ValidateFunction<{
    key: string;
}>;
export declare const validateSessionsCompactionGetParams: AjvPkg.ValidateFunction<{
    key: string;
    checkpointId: string;
}>;
export declare const validateSessionsCompactionBranchParams: AjvPkg.ValidateFunction<{
    key: string;
    checkpointId: string;
}>;
export declare const validateSessionsCompactionRestoreParams: AjvPkg.ValidateFunction<{
    key: string;
    checkpointId: string;
}>;
export declare const validateSessionsUsageParams: AjvPkg.ValidateFunction<{
    key?: string | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
    mode?: "gateway" | "specific" | "utc" | undefined;
    utcOffset?: string | undefined;
    limit?: number | undefined;
    includeContextWeight?: boolean | undefined;
}>;
export declare const validateConfigGetParams: AjvPkg.ValidateFunction<object>;
export declare const validateConfigSetParams: AjvPkg.ValidateFunction<{
    raw: string;
    baseHash?: string | undefined;
}>;
export declare const validateConfigApplyParams: AjvPkg.ValidateFunction<{
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
export declare const validateConfigPatchParams: AjvPkg.ValidateFunction<{
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
export declare const validateConfigSchemaParams: AjvPkg.ValidateFunction<object>;
export declare const validateConfigSchemaLookupParams: AjvPkg.ValidateFunction<{
    path: string;
}>;
export declare const validateConfigSchemaLookupResult: AjvPkg.ValidateFunction<{
    path: string;
    schema: unknown;
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
export declare const validateWizardStartParams: AjvPkg.ValidateFunction<{
    mode?: "local" | "remote" | undefined;
    workspace?: string | undefined;
}>;
export declare const validateWizardNextParams: AjvPkg.ValidateFunction<{
    sessionId: string;
    answer?: {
        stepId: string;
        value?: unknown;
    } | undefined;
}>;
export declare const validateWizardCancelParams: AjvPkg.ValidateFunction<{
    sessionId: string;
}>;
export declare const validateWizardStatusParams: AjvPkg.ValidateFunction<{
    sessionId: string;
}>;
export declare const validateTalkModeParams: AjvPkg.ValidateFunction<{
    enabled: boolean;
    phase?: string | undefined;
}>;
export declare const validateTalkConfigParams: AjvPkg.ValidateFunction<{
    includeSecrets?: boolean | undefined;
}>;
export declare const validateTalkConfigResult: AjvPkg.ValidateFunction<{
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
            resolved: {
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
            };
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
export declare const validateTalkRealtimeSessionParams: AjvPkg.ValidateFunction<{
    sessionKey?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    voice?: string | undefined;
}>;
export declare const validateTalkRealtimeSessionResult: AjvPkg.ValidateFunction<{
    provider: string;
    transport?: "webrtc-sdp" | undefined;
    clientSecret: string;
    offerUrl?: string | undefined;
    offerHeaders?: Record<string, string> | undefined;
    model?: string | undefined;
    voice?: string | undefined;
    expiresAt?: number | undefined;
} | {
    provider: string;
    transport: "json-pcm-websocket";
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
export declare const validateTalkRealtimeRelayAudioParams: AjvPkg.ValidateFunction<{
    relaySessionId: string;
    audioBase64: string;
    timestamp?: number | undefined;
}>;
export declare const validateTalkRealtimeRelayMarkParams: AjvPkg.ValidateFunction<{
    relaySessionId: string;
    markName?: string | undefined;
}>;
export declare const validateTalkRealtimeRelayStopParams: AjvPkg.ValidateFunction<{
    relaySessionId: string;
}>;
export declare const validateTalkRealtimeRelayToolResultParams: AjvPkg.ValidateFunction<{
    relaySessionId: string;
    callId: string;
    result: unknown;
}>;
export declare const validateTalkSpeakParams: AjvPkg.ValidateFunction<{
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
export declare const validateTalkSpeakResult: AjvPkg.ValidateFunction<{
    audioBase64: string;
    provider: string;
    outputFormat?: string | undefined;
    voiceCompatible?: boolean | undefined;
    mimeType?: string | undefined;
    fileExtension?: string | undefined;
}>;
export declare const validateChannelsStatusParams: AjvPkg.ValidateFunction<{
    probe?: boolean | undefined;
    timeoutMs?: number | undefined;
}>;
export declare const validateChannelsStartParams: AjvPkg.ValidateFunction<{
    channel: string;
    accountId?: string | undefined;
}>;
export declare const validateChannelsStopParams: AjvPkg.ValidateFunction<{
    channel: string;
    accountId?: string | undefined;
}>;
export declare const validateChannelsLogoutParams: AjvPkg.ValidateFunction<{
    channel: string;
    accountId?: string | undefined;
}>;
export declare const validateModelsListParams: AjvPkg.ValidateFunction<{
    view?: "all" | "configured" | "default" | undefined;
}>;
export declare const validateSkillsStatusParams: AjvPkg.ValidateFunction<{
    agentId?: string | undefined;
}>;
export declare const validateToolsCatalogParams: AjvPkg.ValidateFunction<{
    agentId?: string | undefined;
    includePlugins?: boolean | undefined;
}>;
export declare const validateToolsEffectiveParams: AjvPkg.ValidateFunction<{
    agentId?: string | undefined;
    sessionKey: string;
}>;
export declare const validateToolsInvokeParams: AjvPkg.ValidateFunction<{
    name: string;
    args?: Record<string, unknown> | undefined;
    sessionKey?: string | undefined;
    agentId?: string | undefined;
    confirm?: boolean | undefined;
    idempotencyKey?: string | undefined;
}>;
export declare const validateSkillsBinsParams: AjvPkg.ValidateFunction<object>;
export declare const validateSkillsInstallParams: AjvPkg.ValidateFunction<{
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
}>;
export declare const validateSkillsUpdateParams: AjvPkg.ValidateFunction<{
    skillKey: string;
    enabled?: boolean | undefined;
    apiKey?: string | undefined;
    env?: Record<string, string> | undefined;
} | {
    source: "clawhub";
    slug?: string | undefined;
    all?: boolean | undefined;
}>;
export declare const validateSkillsSearchParams: AjvPkg.ValidateFunction<{
    query?: string | undefined;
    limit?: number | undefined;
}>;
export declare const validateSkillsDetailParams: AjvPkg.ValidateFunction<{
    slug: string;
}>;
export declare const validateCronListParams: AjvPkg.ValidateFunction<{
    includeDisabled?: boolean | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    query?: string | undefined;
    enabled?: "all" | "disabled" | "enabled" | undefined;
    sortBy?: "name" | "nextRunAtMs" | "updatedAtMs" | undefined;
    sortDir?: "asc" | "desc" | undefined;
}>;
export declare const validateCronStatusParams: AjvPkg.ValidateFunction<object>;
export declare const validateCronAddParams: AjvPkg.ValidateFunction<{
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
export declare const validateCronUpdateParams: AjvPkg.ValidateFunction<{
    id: string;
} | {
    jobId: string;
}>;
export declare const validateCronRemoveParams: AjvPkg.ValidateFunction<{
    id: string;
} | {
    jobId: string;
}>;
export declare const validateCronRunParams: AjvPkg.ValidateFunction<{
    id: string;
} | {
    jobId: string;
}>;
export declare const validateCronRunsParams: AjvPkg.ValidateFunction<{
    scope?: "all" | "job" | undefined;
    id?: string | undefined;
    jobId?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    statuses?: ("error" | "ok" | "skipped")[] | undefined;
    status?: "all" | "error" | "ok" | "skipped" | undefined;
    deliveryStatuses?: ("delivered" | "not-delivered" | "not-requested" | "unknown")[] | undefined;
    deliveryStatus?: "delivered" | "not-delivered" | "not-requested" | "unknown" | undefined;
    query?: string | undefined;
    sortDir?: "asc" | "desc" | undefined;
}>;
export declare const validateDevicePairListParams: AjvPkg.ValidateFunction<object>;
export declare const validateDevicePairApproveParams: AjvPkg.ValidateFunction<{
    requestId: string;
}>;
export declare const validateDevicePairRejectParams: AjvPkg.ValidateFunction<{
    requestId: string;
}>;
export declare const validateDevicePairRemoveParams: AjvPkg.ValidateFunction<{
    deviceId: string;
}>;
export declare const validateDeviceTokenRotateParams: AjvPkg.ValidateFunction<{
    deviceId: string;
    role: string;
    scopes?: string[] | undefined;
}>;
export declare const validateDeviceTokenRevokeParams: AjvPkg.ValidateFunction<{
    deviceId: string;
    role: string;
}>;
export declare const validateExecApprovalsGetParams: AjvPkg.ValidateFunction<object>;
export declare const validateExecApprovalsSetParams: AjvPkg.ValidateFunction<{
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
export declare const validateExecApprovalGetParams: AjvPkg.ValidateFunction<{
    id: string;
}>;
export declare const validateExecApprovalRequestParams: AjvPkg.ValidateFunction<{
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
export declare const validateExecApprovalResolveParams: AjvPkg.ValidateFunction<{
    id: string;
    decision: string;
}>;
export declare const validatePluginApprovalRequestParams: AjvPkg.ValidateFunction<{
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
export declare const validatePluginApprovalResolveParams: AjvPkg.ValidateFunction<{
    id: string;
    decision: string;
}>;
export declare const validatePluginsUiDescriptorsParams: AjvPkg.ValidateFunction<object>;
export declare const validateExecApprovalsNodeGetParams: AjvPkg.ValidateFunction<{
    nodeId: string;
}>;
export declare const validateExecApprovalsNodeSetParams: AjvPkg.ValidateFunction<{
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
export declare const validateLogsTailParams: AjvPkg.ValidateFunction<{
    cursor?: number | undefined;
    limit?: number | undefined;
    maxBytes?: number | undefined;
}>;
export declare const validateChatHistoryParams: AjvPkg.ValidateFunction<{
    sessionKey: any;
}>;
export declare const validateChatSendParams: AjvPkg.ValidateFunction<{
    idempotencyKey: any;
    message: any;
    sessionKey: any;
} & {
    idempotencyKey: any;
} & {
    message: any;
} & {
    sessionKey: any;
}>;
export declare const validateChatAbortParams: AjvPkg.ValidateFunction<{
    sessionKey: string;
    runId?: string | undefined;
}>;
export declare const validateChatInjectParams: AjvPkg.ValidateFunction<{
    sessionKey: string;
    message: string;
    label?: string | undefined;
}>;
export declare const validateChatEvent: AjvPkg.ValidateFunction<{
    runId: any;
    seq: any;
    sessionKey: any;
    state: any;
} & {
    runId: any;
} & {
    seq: any;
} & {
    sessionKey: any;
} & {
    state: any;
}>;
export declare const validateUpdateStatusParams: AjvPkg.ValidateFunction<object>;
export declare const validateUpdateRunParams: AjvPkg.ValidateFunction<{
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
export declare const validateWebLoginStartParams: AjvPkg.ValidateFunction<{
    force?: boolean | undefined;
    timeoutMs?: number | undefined;
    verbose?: boolean | undefined;
    accountId?: string | undefined;
}>;
export declare const validateWebLoginWaitParams: AjvPkg.ValidateFunction<{
    timeoutMs?: number | undefined;
    accountId?: string | undefined;
    currentQrDataUrl?: string | undefined;
}>;
export declare function formatValidationErrors(errors: ErrorObject[] | null | undefined): string;
export { ConnectParamsSchema, HelloOkSchema, RequestFrameSchema, ResponseFrameSchema, EventFrameSchema, GatewayFrameSchema, PresenceEntrySchema, SnapshotSchema, ErrorShapeSchema, StateVersionSchema, AgentEventSchema, MessageActionParamsSchema, ChatEventSchema, SendParamsSchema, PollParamsSchema, AgentParamsSchema, AgentIdentityParamsSchema, AgentIdentityResultSchema, WakeParamsSchema, PushTestParamsSchema, PushTestResultSchema, WebPushVapidPublicKeyParamsSchema, WebPushSubscribeParamsSchema, WebPushUnsubscribeParamsSchema, WebPushTestParamsSchema, NodePairRequestParamsSchema, NodePairListParamsSchema, NodePairApproveParamsSchema, NodePairRejectParamsSchema, NodePairRemoveParamsSchema, NodePairVerifyParamsSchema, NodeListParamsSchema, NodePendingAckParamsSchema, NodeInvokeParamsSchema, NodeEventResultSchema, NodePresenceAlivePayloadSchema, NodePresenceAliveReasonSchema, NodePendingDrainParamsSchema, NodePendingDrainResultSchema, NodePendingEnqueueParamsSchema, NodePendingEnqueueResultSchema, SessionsListParamsSchema, SessionsCleanupParamsSchema, SessionsPreviewParamsSchema, SessionsDescribeParamsSchema, SessionsResolveParamsSchema, SessionsCompactionListParamsSchema, SessionsCompactionGetParamsSchema, SessionsCompactionBranchParamsSchema, SessionsCompactionRestoreParamsSchema, SessionsCreateParamsSchema, SessionsSendParamsSchema, SessionsAbortParamsSchema, SessionsPatchParamsSchema, SessionsPluginPatchParamsSchema, SessionsResetParamsSchema, SessionsDeleteParamsSchema, SessionsCompactParamsSchema, SessionsUsageParamsSchema, ArtifactSummarySchema, ArtifactsListParamsSchema, ArtifactsGetParamsSchema, ArtifactsDownloadParamsSchema, ConfigGetParamsSchema, ConfigSetParamsSchema, ConfigApplyParamsSchema, ConfigPatchParamsSchema, ConfigSchemaParamsSchema, ConfigSchemaLookupParamsSchema, ConfigSchemaResponseSchema, ConfigSchemaLookupResultSchema, UpdateStatusParamsSchema, WizardStartParamsSchema, WizardNextParamsSchema, WizardCancelParamsSchema, WizardStatusParamsSchema, WizardStepSchema, WizardNextResultSchema, WizardStartResultSchema, WizardStatusResultSchema, TalkConfigParamsSchema, TalkConfigResultSchema, TalkRealtimeSessionParamsSchema, TalkRealtimeSessionResultSchema, TalkRealtimeRelayAudioParamsSchema, TalkRealtimeRelayMarkParamsSchema, TalkRealtimeRelayStopParamsSchema, TalkRealtimeRelayToolResultParamsSchema, TalkRealtimeRelayOkResultSchema, TalkSpeakParamsSchema, TalkSpeakResultSchema, ChannelsStatusParamsSchema, ChannelsStatusResultSchema, ChannelsStartParamsSchema, ChannelsStopParamsSchema, ChannelsLogoutParamsSchema, WebLoginStartParamsSchema, WebLoginWaitParamsSchema, AgentSummarySchema, AgentsFileEntrySchema, AgentsCreateParamsSchema, AgentsCreateResultSchema, AgentsUpdateParamsSchema, AgentsUpdateResultSchema, AgentsDeleteParamsSchema, AgentsDeleteResultSchema, AgentsFilesListParamsSchema, AgentsFilesListResultSchema, AgentsFilesGetParamsSchema, AgentsFilesGetResultSchema, AgentsFilesSetParamsSchema, AgentsFilesSetResultSchema, AgentsListParamsSchema, AgentsListResultSchema, CommandsListParamsSchema, CommandsListResultSchema, PluginsUiDescriptorsParamsSchema, ModelsListParamsSchema, SkillsStatusParamsSchema, ToolsCatalogParamsSchema, ToolsEffectiveParamsSchema, ToolsInvokeParamsSchema, SkillsInstallParamsSchema, SkillsSearchParamsSchema, SkillsSearchResultSchema, SkillsDetailParamsSchema, SkillsDetailResultSchema, SkillsUpdateParamsSchema, CronJobSchema, CronListParamsSchema, CronStatusParamsSchema, CronAddParamsSchema, CronUpdateParamsSchema, CronRemoveParamsSchema, CronRunParamsSchema, CronRunsParamsSchema, LogsTailParamsSchema, LogsTailResultSchema, ExecApprovalsGetParamsSchema, ExecApprovalsSetParamsSchema, ExecApprovalGetParamsSchema, ExecApprovalRequestParamsSchema, ExecApprovalResolveParamsSchema, ChatHistoryParamsSchema, ChatSendParamsSchema, ChatInjectParamsSchema, UpdateRunParamsSchema, TickEventSchema, ShutdownEventSchema, ProtocolSchemas, PROTOCOL_VERSION, ErrorCodes, errorShape, };
export type { GatewayFrame, ConnectParams, HelloOk, RequestFrame, ResponseFrame, EventFrame, PresenceEntry, Snapshot, ErrorShape, StateVersion, AgentEvent, AgentIdentityParams, AgentIdentityResult, AgentWaitParams, ChatEvent, TickEvent, ShutdownEvent, WakeParams, NodePairRequestParams, NodePairListParams, NodePairApproveParams, DevicePairListParams, DevicePairApproveParams, DevicePairRejectParams, ConfigGetParams, ConfigSetParams, ConfigApplyParams, ConfigPatchParams, ConfigSchemaParams, ConfigSchemaResponse, WizardStartParams, WizardNextParams, WizardCancelParams, WizardStatusParams, WizardStep, WizardNextResult, WizardStartResult, WizardStatusResult, TalkConfigParams, TalkConfigResult, TalkRealtimeSessionParams, TalkRealtimeSessionResult, TalkRealtimeRelayAudioParams, TalkRealtimeRelayMarkParams, TalkRealtimeRelayStopParams, TalkRealtimeRelayToolResultParams, TalkRealtimeRelayOkResult, TalkSpeakParams, TalkSpeakResult, TalkModeParams, ChannelsStatusParams, ChannelsStatusResult, ChannelsStartParams, ChannelsStopParams, ChannelsLogoutParams, WebLoginStartParams, WebLoginWaitParams, AgentSummary, AgentsFileEntry, AgentsCreateParams, AgentsCreateResult, AgentsUpdateParams, AgentsUpdateResult, AgentsDeleteParams, AgentsDeleteResult, AgentsFilesListParams, AgentsFilesListResult, AgentsFilesGetParams, AgentsFilesGetResult, AgentsFilesSetParams, AgentsFilesSetResult, ArtifactSummary, ArtifactsListParams, ArtifactsListResult, ArtifactsGetParams, ArtifactsGetResult, ArtifactsDownloadParams, ArtifactsDownloadResult, AgentsListParams, AgentsListResult, CommandsListParams, CommandsListResult, CommandEntry, SkillsStatusParams, ToolsCatalogParams, ToolsCatalogResult, ToolsEffectiveParams, ToolsEffectiveResult, ToolsInvokeParams, ToolsInvokeResult, SkillsBinsParams, SkillsBinsResult, SkillsSearchParams, SkillsSearchResult, SkillsDetailParams, SkillsDetailResult, SkillsInstallParams, SkillsUpdateParams, NodePairRejectParams, NodePairRemoveParams, NodePairVerifyParams, NodeListParams, NodeInvokeParams, NodeInvokeResultParams, NodeEventParams, NodeEventResult, NodePresenceAlivePayload, NodePresenceAliveReason, NodePendingDrainParams, NodePendingDrainResult, NodePendingEnqueueParams, NodePendingEnqueueResult, SessionsListParams, SessionsCleanupParams, SessionsPreviewParams, SessionsDescribeParams, SessionsResolveParams, SessionsPatchParams, SessionsPatchResult, SessionsResetParams, SessionsDeleteParams, SessionsCompactParams, SessionsUsageParams, CronJob, CronListParams, CronStatusParams, CronAddParams, CronUpdateParams, CronRemoveParams, CronRunParams, CronRunsParams, CronRunLogEntry, ExecApprovalsGetParams, ExecApprovalsSetParams, ExecApprovalsSnapshot, ExecApprovalGetParams, ExecApprovalRequestParams, ExecApprovalResolveParams, LogsTailParams, LogsTailResult, PollParams, WebPushVapidPublicKeyParams, WebPushSubscribeParams, WebPushUnsubscribeParams, WebPushTestParams, UpdateStatusParams, UpdateRunParams, ChatInjectParams, };
