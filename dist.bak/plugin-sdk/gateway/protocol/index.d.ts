import AjvPkg, { type ErrorObject } from "ajv";
import type { SessionsPatchResult } from "../session-utils.types.js";
import { type AgentEvent, AgentEventSchema, type AgentIdentityParams, AgentIdentityParamsSchema, type AgentIdentityResult, AgentIdentityResultSchema, AgentParamsSchema, type AgentSummary, AgentSummarySchema, type AgentsFileEntry, AgentsFileEntrySchema, type AgentsCreateParams, AgentsCreateParamsSchema, type AgentsCreateResult, AgentsCreateResultSchema, type AgentsUpdateParams, AgentsUpdateParamsSchema, type AgentsUpdateResult, AgentsUpdateResultSchema, type AgentsDeleteParams, AgentsDeleteParamsSchema, type AgentsDeleteResult, AgentsDeleteResultSchema, type AgentsFilesGetParams, AgentsFilesGetParamsSchema, type AgentsFilesGetResult, AgentsFilesGetResultSchema, type AgentsFilesListParams, AgentsFilesListParamsSchema, type AgentsFilesListResult, AgentsFilesListResultSchema, type AgentsFilesSetParams, AgentsFilesSetParamsSchema, type AgentsFilesSetResult, AgentsFilesSetResultSchema, type AgentsListParams, AgentsListParamsSchema, type AgentsListResult, AgentsListResultSchema, type AgentWaitParams, type ChannelsLogoutParams, ChannelsLogoutParamsSchema, type TalkConfigParams, TalkConfigParamsSchema, type TalkConfigResult, TalkConfigResultSchema, type ChannelsStatusParams, ChannelsStatusParamsSchema, type ChannelsStatusResult, ChannelsStatusResultSchema, type ChatEvent, ChatEventSchema, ChatHistoryParamsSchema, type ChatInjectParams, ChatInjectParamsSchema, ChatSendParamsSchema, type ConfigApplyParams, ConfigApplyParamsSchema, type ConfigGetParams, ConfigGetParamsSchema, type ConfigPatchParams, ConfigPatchParamsSchema, type ConfigSchemaParams, ConfigSchemaParamsSchema, type ConfigSchemaResponse, ConfigSchemaResponseSchema, type ConfigSetParams, ConfigSetParamsSchema, type ConnectParams, ConnectParamsSchema, type CronAddParams, CronAddParamsSchema, type CronJob, CronJobSchema, type CronListParams, CronListParamsSchema, type CronRemoveParams, CronRemoveParamsSchema, type CronRunLogEntry, type CronRunParams, CronRunParamsSchema, type CronRunsParams, CronRunsParamsSchema, type CronStatusParams, CronStatusParamsSchema, type CronUpdateParams, CronUpdateParamsSchema, type DevicePairApproveParams, type DevicePairListParams, type DevicePairRejectParams, type ExecApprovalsGetParams, type ExecApprovalsSetParams, type ExecApprovalsSnapshot, ErrorCodes, type ErrorShape, ErrorShapeSchema, type EventFrame, EventFrameSchema, errorShape, type GatewayFrame, GatewayFrameSchema, type HelloOk, HelloOkSchema, type LogsTailParams, LogsTailParamsSchema, type LogsTailResult, LogsTailResultSchema, ModelsListParamsSchema, type NodeEventParams, type NodeInvokeParams, NodeInvokeParamsSchema, type NodeInvokeResultParams, type NodeListParams, NodeListParamsSchema, type NodePairApproveParams, NodePairApproveParamsSchema, type NodePairListParams, NodePairListParamsSchema, type NodePairRejectParams, NodePairRejectParamsSchema, type NodePairRequestParams, NodePairRequestParamsSchema, type NodePairVerifyParams, NodePairVerifyParamsSchema, type PollParams, PollParamsSchema, PROTOCOL_VERSION, PushTestParamsSchema, PushTestResultSchema, type PresenceEntry, PresenceEntrySchema, ProtocolSchemas, type RequestFrame, RequestFrameSchema, type ResponseFrame, ResponseFrameSchema, SendParamsSchema, type SessionsCompactParams, SessionsCompactParamsSchema, type SessionsDeleteParams, SessionsDeleteParamsSchema, type SessionsListParams, SessionsListParamsSchema, type SessionsPatchParams, SessionsPatchParamsSchema, type SessionsPreviewParams, SessionsPreviewParamsSchema, type SessionsResetParams, SessionsResetParamsSchema, type SessionsResolveParams, type SessionsUsageParams, SessionsUsageParamsSchema, type ShutdownEvent, ShutdownEventSchema, type SkillsBinsParams, type SkillsBinsResult, type SkillsInstallParams, SkillsInstallParamsSchema, type SkillsStatusParams, SkillsStatusParamsSchema, type SkillsUpdateParams, SkillsUpdateParamsSchema, type ToolsCatalogParams, ToolsCatalogParamsSchema, type ToolsCatalogResult, type Snapshot, SnapshotSchema, type StateVersion, StateVersionSchema, type TalkModeParams, type TickEvent, TickEventSchema, type UpdateRunParams, UpdateRunParamsSchema, type WakeParams, WakeParamsSchema, type WebLoginStartParams, WebLoginStartParamsSchema, type WebLoginWaitParams, WebLoginWaitParamsSchema, type WizardCancelParams, WizardCancelParamsSchema, type WizardNextParams, WizardNextParamsSchema, type WizardNextResult, WizardNextResultSchema, type WizardStartParams, WizardStartParamsSchema, type WizardStartResult, WizardStartResultSchema, type WizardStatusParams, WizardStatusParamsSchema, type WizardStatusResult, WizardStatusResultSchema, type WizardStep, WizardStepSchema } from "./schema.js";
export declare const validateConnectParams: AjvPkg.ValidateFunction<{
    commands?: string[] | undefined;
    permissions?: {
        [x: string]: boolean;
    } | undefined;
    auth?: {
        token?: string | undefined;
        password?: string | undefined;
        deviceToken?: string | undefined;
    } | undefined;
    role?: string | undefined;
    scopes?: string[] | undefined;
    device?: {
        id: string;
        publicKey: string;
        signature: string;
        signedAt: number;
        nonce: string;
    } | undefined;
    caps?: string[] | undefined;
    pathEnv?: string | undefined;
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
        mode: "node" | "cli" | "ui" | "test" | "webchat" | "backend" | "probe";
        id: "cli" | "test" | "webchat" | "webchat-ui" | "openclaw-control-ui" | "gateway-client" | "openclaw-macos" | "openclaw-ios" | "openclaw-android" | "node-host" | "fingerprint" | "openclaw-probe";
        platform: string;
    };
}>;
export declare const validateRequestFrame: AjvPkg.ValidateFunction<{
    params?: unknown;
    id: string;
    type: "req";
    method: string;
}>;
export declare const validateResponseFrame: AjvPkg.ValidateFunction<{
    payload?: unknown;
    error?: {
        details?: unknown;
        retryAfterMs?: number | undefined;
        retryable?: boolean | undefined;
        message: string;
        code: string;
    } | undefined;
    id: string;
    type: "res";
    ok: boolean;
}>;
export declare const validateEventFrame: AjvPkg.ValidateFunction<{
    payload?: unknown;
    seq?: number | undefined;
    stateVersion?: {
        presence: number;
        health: number;
    } | undefined;
    type: "event";
    event: string;
}>;
export declare const validateSendParams: AjvPkg.ValidateFunction<{
    to: any;
    idempotencyKey: any;
} & {
    to: any;
} & {
    idempotencyKey: any;
}>;
export declare const validatePollParams: AjvPkg.ValidateFunction<{
    channel?: string | undefined;
    silent?: boolean | undefined;
    accountId?: string | undefined;
    threadId?: string | undefined;
    maxSelections?: number | undefined;
    durationSeconds?: number | undefined;
    durationHours?: number | undefined;
    isAnonymous?: boolean | undefined;
    to: string;
    options: string[];
    idempotencyKey: string;
    question: string;
}>;
export declare const validateAgentParams: AjvPkg.ValidateFunction<{
    message: any;
    idempotencyKey: any;
} & {
    message: any;
} & {
    idempotencyKey: any;
}>;
export declare const validateAgentIdentityParams: AjvPkg.ValidateFunction<{
    agentId?: string | undefined;
    sessionKey?: string | undefined;
}>;
export declare const validateAgentWaitParams: AjvPkg.ValidateFunction<{
    timeoutMs?: number | undefined;
    runId: string;
}>;
export declare const validateWakeParams: AjvPkg.ValidateFunction<{
    mode: "now" | "next-heartbeat";
    text: string;
}>;
export declare const validateAgentsListParams: AjvPkg.ValidateFunction<{}>;
export declare const validateAgentsCreateParams: AjvPkg.ValidateFunction<{
    emoji?: string | undefined;
    avatar?: string | undefined;
    name: string;
    workspace: string;
}>;
export declare const validateAgentsUpdateParams: AjvPkg.ValidateFunction<{
    name?: string | undefined;
    workspace?: string | undefined;
    model?: string | undefined;
    avatar?: string | undefined;
    agentId: string;
}>;
export declare const validateAgentsDeleteParams: AjvPkg.ValidateFunction<{
    deleteFiles?: boolean | undefined;
    agentId: string;
}>;
export declare const validateAgentsFilesListParams: AjvPkg.ValidateFunction<{
    agentId: string;
}>;
export declare const validateAgentsFilesGetParams: AjvPkg.ValidateFunction<{
    name: string;
    agentId: string;
}>;
export declare const validateAgentsFilesSetParams: AjvPkg.ValidateFunction<{
    name: string;
    agentId: string;
    content: string;
}>;
export declare const validateNodePairRequestParams: AjvPkg.ValidateFunction<{
    commands?: string[] | undefined;
    version?: string | undefined;
    silent?: boolean | undefined;
    platform?: string | undefined;
    displayName?: string | undefined;
    deviceFamily?: string | undefined;
    remoteIp?: string | undefined;
    modelIdentifier?: string | undefined;
    caps?: string[] | undefined;
    coreVersion?: string | undefined;
    uiVersion?: string | undefined;
    nodeId: string;
}>;
export declare const validateNodePairListParams: AjvPkg.ValidateFunction<{}>;
export declare const validateNodePairApproveParams: AjvPkg.ValidateFunction<{
    requestId: string;
}>;
export declare const validateNodePairRejectParams: AjvPkg.ValidateFunction<{
    requestId: string;
}>;
export declare const validateNodePairVerifyParams: AjvPkg.ValidateFunction<{
    token: string;
    nodeId: string;
}>;
export declare const validateNodeRenameParams: AjvPkg.ValidateFunction<{
    displayName: string;
    nodeId: string;
}>;
export declare const validateNodeListParams: AjvPkg.ValidateFunction<{}>;
export declare const validateNodeDescribeParams: AjvPkg.ValidateFunction<{
    nodeId: string;
}>;
export declare const validateNodeInvokeParams: AjvPkg.ValidateFunction<{
    timeoutMs?: number | undefined;
    params?: unknown;
    command: string;
    idempotencyKey: string;
    nodeId: string;
}>;
export declare const validateNodeInvokeResultParams: AjvPkg.ValidateFunction<{
    payload?: unknown;
    error?: {
        message?: string | undefined;
        code?: string | undefined;
    } | undefined;
    payloadJSON?: string | undefined;
    id: string;
    ok: boolean;
    nodeId: string;
}>;
export declare const validateNodeEventParams: AjvPkg.ValidateFunction<{
    payload?: unknown;
    payloadJSON?: string | undefined;
    event: string;
}>;
export declare const validatePushTestParams: AjvPkg.ValidateFunction<{
    body?: string | undefined;
    title?: string | undefined;
    environment?: string | undefined;
    nodeId: string;
}>;
export declare const validateSessionsListParams: AjvPkg.ValidateFunction<{
    search?: string | undefined;
    agentId?: string | undefined;
    label?: string | undefined;
    limit?: number | undefined;
    spawnedBy?: string | undefined;
    activeMinutes?: number | undefined;
    includeGlobal?: boolean | undefined;
    includeUnknown?: boolean | undefined;
    includeDerivedTitles?: boolean | undefined;
    includeLastMessage?: boolean | undefined;
}>;
export declare const validateSessionsPreviewParams: AjvPkg.ValidateFunction<{
    limit?: number | undefined;
    maxChars?: number | undefined;
    keys: string[];
}>;
export declare const validateSessionsResolveParams: AjvPkg.ValidateFunction<{
    agentId?: string | undefined;
    key?: string | undefined;
    label?: string | undefined;
    sessionId?: string | undefined;
    spawnedBy?: string | undefined;
    includeGlobal?: boolean | undefined;
    includeUnknown?: boolean | undefined;
}>;
export declare const validateSessionsPatchParams: AjvPkg.ValidateFunction<{
    label?: string | null | undefined;
    model?: string | null | undefined;
    execHost?: string | null | undefined;
    execSecurity?: string | null | undefined;
    execAsk?: string | null | undefined;
    execNode?: string | null | undefined;
    spawnedBy?: string | null | undefined;
    spawnDepth?: number | null | undefined;
    thinkingLevel?: string | null | undefined;
    verboseLevel?: string | null | undefined;
    reasoningLevel?: string | null | undefined;
    elevatedLevel?: string | null | undefined;
    responseUsage?: "full" | "off" | "on" | "tokens" | null | undefined;
    groupActivation?: "always" | "mention" | null | undefined;
    sendPolicy?: "deny" | "allow" | null | undefined;
    key: string;
}>;
export declare const validateSessionsResetParams: AjvPkg.ValidateFunction<{
    reason?: "new" | "reset" | undefined;
    key: string;
}>;
export declare const validateSessionsDeleteParams: AjvPkg.ValidateFunction<{
    deleteTranscript?: boolean | undefined;
    emitLifecycleHooks?: boolean | undefined;
    key: string;
}>;
export declare const validateSessionsCompactParams: AjvPkg.ValidateFunction<{
    maxLines?: number | undefined;
    key: string;
}>;
export declare const validateSessionsUsageParams: AjvPkg.ValidateFunction<{
    key?: string | undefined;
    mode?: "gateway" | "utc" | "specific" | undefined;
    limit?: number | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
    utcOffset?: string | undefined;
    includeContextWeight?: boolean | undefined;
}>;
export declare const validateConfigGetParams: AjvPkg.ValidateFunction<{}>;
export declare const validateConfigSetParams: AjvPkg.ValidateFunction<{
    baseHash?: string | undefined;
    raw: string;
}>;
export declare const validateConfigApplyParams: AjvPkg.ValidateFunction<{
    sessionKey?: string | undefined;
    baseHash?: string | undefined;
    note?: string | undefined;
    restartDelayMs?: number | undefined;
    raw: string;
}>;
export declare const validateConfigPatchParams: AjvPkg.ValidateFunction<{
    sessionKey?: string | undefined;
    baseHash?: string | undefined;
    note?: string | undefined;
    restartDelayMs?: number | undefined;
    raw: string;
}>;
export declare const validateConfigSchemaParams: AjvPkg.ValidateFunction<{}>;
export declare const validateWizardStartParams: AjvPkg.ValidateFunction<{
    mode?: "local" | "remote" | undefined;
    workspace?: string | undefined;
}>;
export declare const validateWizardNextParams: AjvPkg.ValidateFunction<{
    answer?: {
        value?: unknown;
        stepId: string;
    } | undefined;
    sessionId: string;
}>;
export declare const validateWizardCancelParams: AjvPkg.ValidateFunction<{
    sessionId: string;
}>;
export declare const validateWizardStatusParams: AjvPkg.ValidateFunction<{
    sessionId: string;
}>;
export declare const validateTalkModeParams: AjvPkg.ValidateFunction<{
    phase?: string | undefined;
    enabled: boolean;
}>;
export declare const validateTalkConfigParams: AjvPkg.ValidateFunction<{
    includeSecrets?: boolean | undefined;
}>;
export declare const validateChannelsStatusParams: AjvPkg.ValidateFunction<{
    timeoutMs?: number | undefined;
    probe?: boolean | undefined;
}>;
export declare const validateChannelsLogoutParams: AjvPkg.ValidateFunction<{
    accountId?: string | undefined;
    channel: string;
}>;
export declare const validateModelsListParams: AjvPkg.ValidateFunction<{}>;
export declare const validateSkillsStatusParams: AjvPkg.ValidateFunction<{
    agentId?: string | undefined;
}>;
export declare const validateToolsCatalogParams: AjvPkg.ValidateFunction<{
    agentId?: string | undefined;
    includePlugins?: boolean | undefined;
}>;
export declare const validateSkillsBinsParams: AjvPkg.ValidateFunction<{}>;
export declare const validateSkillsInstallParams: AjvPkg.ValidateFunction<{
    timeoutMs?: number | undefined;
    name: string;
    installId: string;
}>;
export declare const validateSkillsUpdateParams: AjvPkg.ValidateFunction<{
    env?: {
        [x: string]: string;
    } | undefined;
    enabled?: boolean | undefined;
    apiKey?: string | undefined;
    skillKey: string;
}>;
export declare const validateCronListParams: AjvPkg.ValidateFunction<{
    enabled?: "all" | "disabled" | "enabled" | undefined;
    limit?: number | undefined;
    includeDisabled?: boolean | undefined;
    offset?: number | undefined;
    query?: string | undefined;
    sortBy?: "name" | "updatedAtMs" | "nextRunAtMs" | undefined;
    sortDir?: "asc" | "desc" | undefined;
}>;
export declare const validateCronStatusParams: AjvPkg.ValidateFunction<{}>;
export declare const validateCronAddParams: AjvPkg.ValidateFunction<{
    agentId?: string | null | undefined;
    enabled?: boolean | undefined;
    sessionKey?: string | null | undefined;
    description?: string | undefined;
    deleteAfterRun?: boolean | undefined;
    delivery?: {
        channel?: string | undefined;
        accountId?: string | undefined;
        to?: string | undefined;
        bestEffort?: boolean | undefined;
        mode: "none";
    } | {
        channel?: string | undefined;
        accountId?: string | undefined;
        to?: string | undefined;
        bestEffort?: boolean | undefined;
        mode: "announce";
    } | {
        channel?: string | undefined;
        accountId?: string | undefined;
        bestEffort?: boolean | undefined;
        mode: "webhook";
        to: string;
    } | undefined;
    name: string;
    payload: {
        text: string;
        kind: "systemEvent";
    } | {
        channel?: string | undefined;
        thinking?: string | undefined;
        model?: string | undefined;
        timeoutSeconds?: number | undefined;
        to?: string | undefined;
        deliver?: boolean | undefined;
        bestEffortDeliver?: boolean | undefined;
        allowUnsafeExternalContent?: boolean | undefined;
        message: unknown;
        kind: "agentTurn";
    };
    schedule: {
        at: string;
        kind: "at";
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
    sessionTarget: "main" | "isolated";
    wakeMode: "now" | "next-heartbeat";
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
    id?: string | undefined;
    status?: "skipped" | "error" | "all" | "ok" | undefined;
    limit?: number | undefined;
    scope?: "all" | "job" | undefined;
    jobId?: string | undefined;
    offset?: number | undefined;
    query?: string | undefined;
    sortDir?: "asc" | "desc" | undefined;
    statuses?: ("skipped" | "error" | "ok")[] | undefined;
    deliveryStatuses?: ("unknown" | "delivered" | "not-delivered" | "not-requested")[] | undefined;
    deliveryStatus?: "unknown" | "delivered" | "not-delivered" | "not-requested" | undefined;
}>;
export declare const validateDevicePairListParams: AjvPkg.ValidateFunction<{}>;
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
    scopes?: string[] | undefined;
    role: string;
    deviceId: string;
}>;
export declare const validateDeviceTokenRevokeParams: AjvPkg.ValidateFunction<{
    role: string;
    deviceId: string;
}>;
export declare const validateExecApprovalsGetParams: AjvPkg.ValidateFunction<{}>;
export declare const validateExecApprovalsSetParams: AjvPkg.ValidateFunction<{
    baseHash?: string | undefined;
    file: {
        socket?: {
            path?: string | undefined;
            token?: string | undefined;
        } | undefined;
        agents?: {
            [x: string]: {
                allowlist?: {
                    id?: string | undefined;
                    lastUsedAt?: number | undefined;
                    lastUsedCommand?: string | undefined;
                    lastResolvedPath?: string | undefined;
                    pattern: string;
                }[] | undefined;
                security?: string | undefined;
                ask?: string | undefined;
                askFallback?: string | undefined;
                autoAllowSkills?: boolean | undefined;
            };
        } | undefined;
        defaults?: {
            security?: string | undefined;
            ask?: string | undefined;
            askFallback?: string | undefined;
            autoAllowSkills?: boolean | undefined;
        } | undefined;
        version: 1;
    };
}>;
export declare const validateExecApprovalRequestParams: AjvPkg.ValidateFunction<{
    agentId?: string | null | undefined;
    timeoutMs?: number | undefined;
    env?: {
        [x: string]: string;
    } | undefined;
    resolvedPath?: string | null | undefined;
    security?: string | null | undefined;
    ask?: string | null | undefined;
    id?: string | undefined;
    cwd?: string | null | undefined;
    host?: string | null | undefined;
    sessionKey?: string | null | undefined;
    nodeId?: string | null | undefined;
    commandArgv?: string[] | undefined;
    systemRunPlanV2?: {
        agentId: string | null;
        argv: string[];
        version: 2;
        cwd: string | null;
        sessionKey: string | null;
        rawCommand: string | null;
    } | undefined;
    turnSourceChannel?: string | null | undefined;
    turnSourceTo?: string | null | undefined;
    turnSourceAccountId?: string | null | undefined;
    turnSourceThreadId?: string | number | null | undefined;
    twoPhase?: boolean | undefined;
    command: string;
}>;
export declare const validateExecApprovalResolveParams: AjvPkg.ValidateFunction<{
    decision: string;
    id: string;
}>;
export declare const validateExecApprovalsNodeGetParams: AjvPkg.ValidateFunction<{
    nodeId: string;
}>;
export declare const validateExecApprovalsNodeSetParams: AjvPkg.ValidateFunction<{
    baseHash?: string | undefined;
    file: {
        socket?: {
            path?: string | undefined;
            token?: string | undefined;
        } | undefined;
        agents?: {
            [x: string]: {
                allowlist?: {
                    id?: string | undefined;
                    lastUsedAt?: number | undefined;
                    lastUsedCommand?: string | undefined;
                    lastResolvedPath?: string | undefined;
                    pattern: string;
                }[] | undefined;
                security?: string | undefined;
                ask?: string | undefined;
                askFallback?: string | undefined;
                autoAllowSkills?: boolean | undefined;
            };
        } | undefined;
        defaults?: {
            security?: string | undefined;
            ask?: string | undefined;
            askFallback?: string | undefined;
            autoAllowSkills?: boolean | undefined;
        } | undefined;
        version: 1;
    };
    nodeId: string;
}>;
export declare const validateLogsTailParams: AjvPkg.ValidateFunction<{
    maxBytes?: number | undefined;
    limit?: number | undefined;
    cursor?: number | undefined;
}>;
export declare const validateChatHistoryParams: AjvPkg.ValidateFunction<{
    sessionKey: any;
}>;
export declare const validateChatSendParams: AjvPkg.ValidateFunction<{
    message: any;
    sessionKey: any;
    idempotencyKey: any;
} & {
    message: any;
} & {
    sessionKey: any;
} & {
    idempotencyKey: any;
}>;
export declare const validateChatAbortParams: AjvPkg.ValidateFunction<{
    runId?: string | undefined;
    sessionKey: string;
}>;
export declare const validateChatInjectParams: AjvPkg.ValidateFunction<{
    label?: string | undefined;
    message: string;
    sessionKey: string;
}>;
export declare const validateChatEvent: AjvPkg.ValidateFunction<{
    state: any;
    sessionKey: any;
    seq: any;
    runId: any;
} & {
    state: any;
} & {
    sessionKey: any;
} & {
    seq: any;
} & {
    runId: any;
}>;
export declare const validateUpdateRunParams: AjvPkg.ValidateFunction<{
    timeoutMs?: number | undefined;
    sessionKey?: string | undefined;
    note?: string | undefined;
    restartDelayMs?: number | undefined;
}>;
export declare const validateWebLoginStartParams: AjvPkg.ValidateFunction<{
    timeoutMs?: number | undefined;
    force?: boolean | undefined;
    verbose?: boolean | undefined;
    accountId?: string | undefined;
}>;
export declare const validateWebLoginWaitParams: AjvPkg.ValidateFunction<{
    timeoutMs?: number | undefined;
    accountId?: string | undefined;
}>;
export declare function formatValidationErrors(errors: ErrorObject[] | null | undefined): string;
export { ConnectParamsSchema, HelloOkSchema, RequestFrameSchema, ResponseFrameSchema, EventFrameSchema, GatewayFrameSchema, PresenceEntrySchema, SnapshotSchema, ErrorShapeSchema, StateVersionSchema, AgentEventSchema, ChatEventSchema, SendParamsSchema, PollParamsSchema, AgentParamsSchema, AgentIdentityParamsSchema, AgentIdentityResultSchema, WakeParamsSchema, PushTestParamsSchema, PushTestResultSchema, NodePairRequestParamsSchema, NodePairListParamsSchema, NodePairApproveParamsSchema, NodePairRejectParamsSchema, NodePairVerifyParamsSchema, NodeListParamsSchema, NodeInvokeParamsSchema, SessionsListParamsSchema, SessionsPreviewParamsSchema, SessionsPatchParamsSchema, SessionsResetParamsSchema, SessionsDeleteParamsSchema, SessionsCompactParamsSchema, SessionsUsageParamsSchema, ConfigGetParamsSchema, ConfigSetParamsSchema, ConfigApplyParamsSchema, ConfigPatchParamsSchema, ConfigSchemaParamsSchema, ConfigSchemaResponseSchema, WizardStartParamsSchema, WizardNextParamsSchema, WizardCancelParamsSchema, WizardStatusParamsSchema, WizardStepSchema, WizardNextResultSchema, WizardStartResultSchema, WizardStatusResultSchema, TalkConfigParamsSchema, TalkConfigResultSchema, ChannelsStatusParamsSchema, ChannelsStatusResultSchema, ChannelsLogoutParamsSchema, WebLoginStartParamsSchema, WebLoginWaitParamsSchema, AgentSummarySchema, AgentsFileEntrySchema, AgentsCreateParamsSchema, AgentsCreateResultSchema, AgentsUpdateParamsSchema, AgentsUpdateResultSchema, AgentsDeleteParamsSchema, AgentsDeleteResultSchema, AgentsFilesListParamsSchema, AgentsFilesListResultSchema, AgentsFilesGetParamsSchema, AgentsFilesGetResultSchema, AgentsFilesSetParamsSchema, AgentsFilesSetResultSchema, AgentsListParamsSchema, AgentsListResultSchema, ModelsListParamsSchema, SkillsStatusParamsSchema, ToolsCatalogParamsSchema, SkillsInstallParamsSchema, SkillsUpdateParamsSchema, CronJobSchema, CronListParamsSchema, CronStatusParamsSchema, CronAddParamsSchema, CronUpdateParamsSchema, CronRemoveParamsSchema, CronRunParamsSchema, CronRunsParamsSchema, LogsTailParamsSchema, LogsTailResultSchema, ChatHistoryParamsSchema, ChatSendParamsSchema, ChatInjectParamsSchema, UpdateRunParamsSchema, TickEventSchema, ShutdownEventSchema, ProtocolSchemas, PROTOCOL_VERSION, ErrorCodes, errorShape, };
export type { GatewayFrame, ConnectParams, HelloOk, RequestFrame, ResponseFrame, EventFrame, PresenceEntry, Snapshot, ErrorShape, StateVersion, AgentEvent, AgentIdentityParams, AgentIdentityResult, AgentWaitParams, ChatEvent, TickEvent, ShutdownEvent, WakeParams, NodePairRequestParams, NodePairListParams, NodePairApproveParams, DevicePairListParams, DevicePairApproveParams, DevicePairRejectParams, ConfigGetParams, ConfigSetParams, ConfigApplyParams, ConfigPatchParams, ConfigSchemaParams, ConfigSchemaResponse, WizardStartParams, WizardNextParams, WizardCancelParams, WizardStatusParams, WizardStep, WizardNextResult, WizardStartResult, WizardStatusResult, TalkConfigParams, TalkConfigResult, TalkModeParams, ChannelsStatusParams, ChannelsStatusResult, ChannelsLogoutParams, WebLoginStartParams, WebLoginWaitParams, AgentSummary, AgentsFileEntry, AgentsCreateParams, AgentsCreateResult, AgentsUpdateParams, AgentsUpdateResult, AgentsDeleteParams, AgentsDeleteResult, AgentsFilesListParams, AgentsFilesListResult, AgentsFilesGetParams, AgentsFilesGetResult, AgentsFilesSetParams, AgentsFilesSetResult, AgentsListParams, AgentsListResult, SkillsStatusParams, ToolsCatalogParams, ToolsCatalogResult, SkillsBinsParams, SkillsBinsResult, SkillsInstallParams, SkillsUpdateParams, NodePairRejectParams, NodePairVerifyParams, NodeListParams, NodeInvokeParams, NodeInvokeResultParams, NodeEventParams, SessionsListParams, SessionsPreviewParams, SessionsResolveParams, SessionsPatchParams, SessionsPatchResult, SessionsResetParams, SessionsDeleteParams, SessionsCompactParams, SessionsUsageParams, CronJob, CronListParams, CronStatusParams, CronAddParams, CronUpdateParams, CronRemoveParams, CronRunParams, CronRunsParams, CronRunLogEntry, ExecApprovalsGetParams, ExecApprovalsSetParams, ExecApprovalsSnapshot, LogsTailParams, LogsTailResult, PollParams, UpdateRunParams, ChatInjectParams, };
