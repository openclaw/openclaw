import { Jt as PluginConversationBindingRequestResult, Kt as PluginConversationBinding, Yt as PluginConversationBindingResolutionDecision, qt as PluginConversationBindingRequestParams } from "./hook-types-BKz-S4lu.js";
import { r as ConversationRef } from "./session-binding.types-cd2c9es6.js";

//#region src/plugins/conversation-binding.d.ts
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
declare function isPluginOwnedBindingMetadata(metadata: unknown): metadata is PluginBindingMetadata;
declare function isPluginOwnedSessionBindingRecord(record: {
  metadata?: Record<string, unknown>;
} | null | undefined): boolean;
declare function toPluginConversationBinding(record: {
  bindingId: string;
  conversation: ConversationRef;
  boundAt: number;
  metadata?: Record<string, unknown>;
} | null | undefined): PluginConversationBinding | null;
declare function buildPluginBindingUnavailableText(binding: PluginConversationBinding): string;
declare function buildPluginBindingDeclinedText(binding: PluginConversationBinding): string;
declare function buildPluginBindingErrorText(binding: PluginConversationBinding): string;
declare function hasShownPluginBindingFallbackNotice(bindingId: string): boolean;
declare function markPluginBindingFallbackNoticeShown(bindingId: string): void;
declare function buildPluginBindingApprovalCustomId(approvalId: string, decision: PluginBindingApprovalDecision): string;
declare function parsePluginBindingApprovalCustomId(value: string): PluginBindingApprovalAction | null;
declare function requestPluginConversationBinding(params: {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  conversation: PluginBindingConversation;
  requestedBySenderId?: string;
  binding: PluginConversationBindingRequestParams | undefined;
}): Promise<PluginConversationBindingRequestResult>;
declare function getCurrentPluginConversationBinding(params: {
  pluginRoot: string;
  conversation: PluginBindingConversation;
}): Promise<PluginConversationBinding | null>;
declare function detachPluginConversationBinding(params: {
  pluginRoot: string;
  conversation: PluginBindingConversation;
}): Promise<{
  removed: boolean;
}>;
declare function resolvePluginConversationBindingApproval(params: {
  approvalId: string;
  decision: PluginBindingApprovalDecision;
  senderId?: string;
}): Promise<PluginBindingResolveResult>;
declare function buildPluginBindingResolvedText(params: PluginBindingResolveResult): string;
//#endregion
export { buildPluginBindingUnavailableText as a, hasShownPluginBindingFallbackNotice as c, markPluginBindingFallbackNoticeShown as d, parsePluginBindingApprovalCustomId as f, toPluginConversationBinding as h, buildPluginBindingResolvedText as i, isPluginOwnedBindingMetadata as l, resolvePluginConversationBindingApproval as m, buildPluginBindingDeclinedText as n, detachPluginConversationBinding as o, requestPluginConversationBinding as p, buildPluginBindingErrorText as r, getCurrentPluginConversationBinding as s, buildPluginBindingApprovalCustomId as t, isPluginOwnedSessionBindingRecord as u };