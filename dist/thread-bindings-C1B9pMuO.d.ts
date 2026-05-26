import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as BindingTargetKind } from "./session-binding.types-cd2c9es6.js";
//#region extensions/feishu/src/conversation-id.d.ts
type FeishuGroupSessionScope = "group" | "group_sender" | "group_topic" | "group_topic_sender";
declare function buildFeishuConversationId(params: {
  chatId: string;
  scope: FeishuGroupSessionScope;
  senderOpenId?: string;
  topicId?: string;
}): string;
declare function parseFeishuTargetId(raw: unknown): string | undefined;
declare function parseFeishuDirectConversationId(raw: unknown): string | undefined;
declare function parseFeishuConversationId(params: {
  conversationId: string;
  parentConversationId?: string;
}): {
  canonicalConversationId: string;
  chatId: string;
  topicId?: string;
  senderOpenId?: string;
  scope: FeishuGroupSessionScope;
} | null;
declare function buildFeishuModelOverrideParentCandidates(parentConversationId?: string | null): string[];
//#endregion
//#region extensions/feishu/src/thread-bindings.d.ts
type FeishuBindingTargetKind = "subagent" | "acp";
type FeishuThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  deliveryTo?: string;
  deliveryThreadId?: string;
  targetKind: FeishuBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
};
type FeishuThreadBindingManager = {
  accountId: string;
  getByConversationId: (conversationId: string) => FeishuThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => FeishuThreadBindingRecord[];
  bindConversation: (params: {
    conversationId: string;
    parentConversationId?: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => FeishuThreadBindingRecord | null;
  touchConversation: (conversationId: string, at?: number) => FeishuThreadBindingRecord | null;
  unbindConversation: (conversationId: string) => FeishuThreadBindingRecord | null;
  unbindBySessionKey: (targetSessionKey: string) => FeishuThreadBindingRecord[];
  stop: () => void;
};
declare function createFeishuThreadBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): FeishuThreadBindingManager;
declare function getFeishuThreadBindingManager(accountId?: string): FeishuThreadBindingManager | null;
declare const testing: {
  resetFeishuThreadBindingsForTests(): void;
};
//#endregion
export { buildFeishuConversationId as a, parseFeishuDirectConversationId as c, FeishuGroupSessionScope as i, parseFeishuTargetId as l, getFeishuThreadBindingManager as n, buildFeishuModelOverrideParentCandidates as o, testing as r, parseFeishuConversationId as s, createFeishuThreadBindingManager as t };