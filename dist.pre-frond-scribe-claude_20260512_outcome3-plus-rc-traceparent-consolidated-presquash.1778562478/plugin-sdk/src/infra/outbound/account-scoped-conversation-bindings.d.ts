import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type BindingTargetKind } from "./session-binding-service.js";
export type AccountScopedConversationBindingRecord<TKind extends string = string> = {
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
export type AccountScopedConversationBindingManager<TKind extends string = string> = {
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
export declare function createAccountScopedConversationBindingManager<TKind extends string>(params: {
    channel: string;
    cfg: OpenClawConfig;
    stateKey: symbol;
    accountId?: string | null;
    toStoredTargetKind: (raw: BindingTargetKind) => TKind;
    toSessionBindingTargetKind: (raw: TKind) => BindingTargetKind;
}): AccountScopedConversationBindingManager<TKind>;
export declare function resetAccountScopedConversationBindingsForTests(params: {
    stateKey: symbol;
}): void;
