import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { AgentEventPayload, AgentEventStream } from "../infra/agent-events.js";
import type { PluginHookAgentContext, PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult, PluginHookToolContext } from "./hook-types.js";
import type { PluginJsonValue } from "./host-hook-json.js";
import type { PluginAgentTurnPrepareResult, PluginNextTurnInjectionRecord } from "./host-hook-turn-types.js";
export { isPluginJsonValue } from "./host-hook-json.js";
export type { PluginJsonPrimitive, PluginJsonValue } from "./host-hook-json.js";
export type { PluginAgentTurnPrepareEvent, PluginAgentTurnPrepareResult, PluginHeartbeatPromptContributionEvent, PluginHeartbeatPromptContributionResult, PluginNextTurnInjection, PluginNextTurnInjectionEnqueueResult, PluginNextTurnInjectionPlacement, PluginNextTurnInjectionRecord, } from "./host-hook-turn-types.js";
export type PluginHostCleanupReason = "disable" | "reset" | "delete" | "restart";
export type PluginSessionExtensionProjectionContext = {
    sessionKey: string;
    sessionId?: string;
    state: PluginJsonValue | undefined;
};
export type PluginSessionExtensionRegistration = {
    namespace: string;
    description: string;
    project?: (ctx: PluginSessionExtensionProjectionContext) => PluginJsonValue | undefined;
    cleanup?: (ctx: {
        reason: PluginHostCleanupReason;
        sessionKey?: string;
    }) => void | Promise<void>;
};
export type PluginSessionExtensionProjection = {
    pluginId: string;
    namespace: string;
    value: PluginJsonValue;
};
export type PluginSessionExtensionPatchParams = {
    key: string;
    pluginId: string;
    namespace: string;
    value?: PluginJsonValue;
    unset?: boolean;
};
export type PluginToolPolicyDecision = PluginHookBeforeToolCallResult | {
    allow?: boolean;
    reason?: string;
};
export type PluginTrustedToolPolicyRegistration = {
    id: string;
    description: string;
    evaluate: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => PluginToolPolicyDecision | void | Promise<PluginToolPolicyDecision | void>;
};
export type PluginToolMetadataRegistration = {
    toolName: string;
    displayName?: string;
    description?: string;
    risk?: "low" | "medium" | "high";
    tags?: string[];
};
export type PluginCommandContinuation = {
    continueAgent?: boolean;
};
export type PluginControlUiDescriptor = {
    id: string;
    surface: "session" | "tool" | "run" | "settings";
    label: string;
    description?: string;
    placement?: string;
    schema?: PluginJsonValue;
    requiredScopes?: OperatorScope[];
};
export type PluginRuntimeLifecycleRegistration = {
    id: string;
    description?: string;
    cleanup?: (ctx: {
        reason: PluginHostCleanupReason;
        sessionKey?: string;
        runId?: string;
    }) => void | Promise<void>;
};
export type PluginAgentEventSubscriptionRegistration = {
    id: string;
    description?: string;
    streams?: AgentEventStream[];
    handle: (event: AgentEventPayload, ctx: {
        getRunContext: <T extends PluginJsonValue = PluginJsonValue>(namespace: string) => T | undefined;
        setRunContext: (namespace: string, value: PluginJsonValue) => void;
        clearRunContext: (namespace?: string) => void;
    }) => void | Promise<void>;
};
export type PluginRunContextPatch = {
    runId: string;
    namespace: string;
    value?: PluginJsonValue;
    unset?: boolean;
};
export type PluginRunContextGetParams = {
    runId: string;
    namespace: string;
};
export type PluginSessionSchedulerJobRegistration = {
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
export type PluginSessionSchedulerJobHandle = {
    id: string;
    pluginId: string;
    sessionKey: string;
    kind: string;
};
export declare function normalizePluginHostHookId(value: string | undefined): string;
export declare function buildPluginAgentTurnPrepareContext(params: {
    queuedInjections: PluginNextTurnInjectionRecord[];
}): PluginAgentTurnPrepareResult;
export type PluginHostHookRunContext = PluginHookAgentContext;
