import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as BindingTargetKind } from "./session-binding.types-cd2c9es6.js";
//#region src/infra/outbound/account-scoped-conversation-bindings.d.ts
type AccountScopedConversationBindingRecord<TKind extends string = string> = {
  accountId: string;
  conversationId: string;
  targetKind: TKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
};
type AccountScopedConversationBindingManager<TKind extends string = string> = {
  accountId: string;
  getByConversationId: (conversationId: string) => AccountScopedConversationBindingRecord<TKind> | undefined;
  listBySessionKey: (targetSessionKey: string) => AccountScopedConversationBindingRecord<TKind>[];
  bindConversation: (params: {
    conversationId: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => AccountScopedConversationBindingRecord<TKind> | null;
  touchConversation: (conversationId: string, at?: number) => AccountScopedConversationBindingRecord<TKind> | null;
  unbindConversation: (conversationId: string) => AccountScopedConversationBindingRecord<TKind> | null;
  unbindBySessionKey: (targetSessionKey: string) => AccountScopedConversationBindingRecord<TKind>[];
  stop: () => void;
};
declare function createAccountScopedConversationBindingManager<TKind extends string>(params: {
  channel: string;
  cfg: OpenClawConfig;
  stateKey: symbol;
  accountId?: string | null;
  toStoredTargetKind: (raw: BindingTargetKind) => TKind;
  toSessionBindingTargetKind: (raw: TKind) => BindingTargetKind;
}): AccountScopedConversationBindingManager<TKind>;
declare function resetAccountScopedConversationBindingsForTests(params: {
  stateKey: symbol;
}): void;
//#endregion
export { resetAccountScopedConversationBindingsForTests as i, AccountScopedConversationBindingRecord as n, createAccountScopedConversationBindingManager as r, AccountScopedConversationBindingManager as t };