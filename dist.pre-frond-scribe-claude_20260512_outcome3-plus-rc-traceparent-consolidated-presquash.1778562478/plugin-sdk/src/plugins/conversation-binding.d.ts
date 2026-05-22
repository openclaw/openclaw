import { type ConversationRef } from "../infra/outbound/session-binding-service.js";
import type { PluginConversationBinding, PluginConversationBindingResolutionDecision, PluginConversationBindingRequestParams, PluginConversationBindingRequestResult } from "./conversation-binding.types.js";
type PluginBindingApprovalDecision = PluginConversationBindingResolutionDecision;
type PluginBindingConversation = {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string | number;
};
type PendingPluginBindingRequest = {
    id: string;
    pluginId: string;
    pluginName?: string;
    pluginRoot: string;
    conversation: PluginBindingConversation;
    requestedAt: number;
    requestedBySenderId?: string;
    summary?: string;
    detachHint?: string;
    data?: Record<string, unknown>;
};
type PluginBindingApprovalAction = {
    approvalId: string;
    decision: PluginBindingApprovalDecision;
};
type PluginBindingMetadata = {
    pluginBindingOwner: "plugin";
    pluginId: string;
    pluginName?: string;
    pluginRoot: string;
    summary?: string;
    detachHint?: string;
    data?: Record<string, unknown>;
};
type PluginBindingResolveResult = {
    status: "approved";
    binding: PluginConversationBinding;
    request: PendingPluginBindingRequest;
    decision: Exclude<PluginBindingApprovalDecision, "deny">;
} | {
    status: "denied";
    request: PendingPluginBindingRequest;
} | {
    status: "expired";
};
export declare function isPluginOwnedBindingMetadata(metadata: unknown): metadata is PluginBindingMetadata;
export declare function isPluginOwnedSessionBindingRecord(record: {
    metadata?: Record<string, unknown>;
} | null | undefined): boolean;
export declare function toPluginConversationBinding(record: {
    bindingId: string;
    conversation: ConversationRef;
    boundAt: number;
    metadata?: Record<string, unknown>;
} | null | undefined): PluginConversationBinding | null;
export declare function buildPluginBindingUnavailableText(binding: PluginConversationBinding): string;
export declare function buildPluginBindingDeclinedText(binding: PluginConversationBinding): string;
export declare function buildPluginBindingErrorText(binding: PluginConversationBinding): string;
export declare function hasShownPluginBindingFallbackNotice(bindingId: string): boolean;
export declare function markPluginBindingFallbackNoticeShown(bindingId: string): void;
export declare function buildPluginBindingApprovalCustomId(approvalId: string, decision: PluginBindingApprovalDecision): string;
export declare function parsePluginBindingApprovalCustomId(value: string): PluginBindingApprovalAction | null;
export declare function requestPluginConversationBinding(params: {
    pluginId: string;
    pluginName?: string;
    pluginRoot: string;
    conversation: PluginBindingConversation;
    requestedBySenderId?: string;
    binding: PluginConversationBindingRequestParams | undefined;
}): Promise<PluginConversationBindingRequestResult>;
export declare function getCurrentPluginConversationBinding(params: {
    pluginRoot: string;
    conversation: PluginBindingConversation;
}): Promise<PluginConversationBinding | null>;
export declare function detachPluginConversationBinding(params: {
    pluginRoot: string;
    conversation: PluginBindingConversation;
}): Promise<{
    removed: boolean;
}>;
export declare function resolvePluginConversationBindingApproval(params: {
    approvalId: string;
    decision: PluginBindingApprovalDecision;
    senderId?: string;
}): Promise<PluginBindingResolveResult>;
export declare function buildPluginBindingResolvedText(params: PluginBindingResolveResult): string;
export declare const __testing: {
    reset(): void;
};
export {};
