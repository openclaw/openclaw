export type { AgentToAgentPolicy, SessionAccessAction, SessionAccessResult, SessionToolsVisibility, } from "./sessions-access.js";
export { createAgentToAgentPolicy, createSessionVisibilityGuard, resolveEffectiveSessionToolsVisibility, resolveSandboxSessionToolsVisibility, resolveSandboxedSessionToolContext, resolveSessionToolsVisibility, } from "./sessions-access.js";
export type { SessionReferenceResolution } from "./sessions-resolution.js";
export { isRequesterSpawnedSessionVisible, isResolvedSessionVisibleToRequester, listSpawnedSessionKeys, looksLikeSessionId, looksLikeSessionKey, resolveDisplaySessionKey, resolveInternalSessionKey, resolveMainSessionAlias, resolveSessionReference, shouldResolveSessionIdInput, shouldVerifyRequesterSpawnedSessionVisibility, } from "./sessions-resolution.js";
export type SessionKind = "main" | "group" | "cron" | "hook" | "node" | "other";
export type SessionListDeliveryContext = {
    channel?: string;
    to?: string;
    accountId?: string;
};
export type SessionListRow = {
    key: string;
    kind: SessionKind;
    channel: string;
    label?: string;
    displayName?: string;
    deliveryContext?: SessionListDeliveryContext;
    updatedAt?: number | null;
    sessionId?: string;
    model?: string;
    contextTokens?: number | null;
    totalTokens?: number | null;
    thinkingLevel?: string;
    verboseLevel?: string;
    systemSent?: boolean;
    abortedLastRun?: boolean;
    sendPolicy?: string;
    lastChannel?: string;
    lastTo?: string;
    lastAccountId?: string;
    transcriptPath?: string;
    messages?: unknown[];
};
export declare function classifySessionKind(params: {
    key: string;
    gatewayKind?: string | null;
    alias: string;
    mainKey: string;
}): SessionKind;
export declare function deriveChannel(params: {
    key: string;
    kind: SessionKind;
    channel?: string | null;
    lastChannel?: string | null;
}): string;
export declare function stripToolMessages(messages: unknown[]): unknown[];
/**
 * Sanitize text content to strip tool call markers and thinking tags.
 * This ensures user-facing text doesn't leak internal tool representations.
 */
export declare function sanitizeTextContent(text: string): string;
export declare function extractAssistantText(message: unknown): string | undefined;
