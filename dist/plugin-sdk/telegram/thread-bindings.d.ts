type TelegramBindingTargetKind = "subagent" | "acp";
export type TelegramThreadBindingRecord = {
    accountId: string;
    conversationId: string;
    targetKind: TelegramBindingTargetKind;
    targetSessionKey: string;
    agentId?: string;
    label?: string;
    boundBy?: string;
    boundAt: number;
    lastActivityAt: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
};
export type TelegramThreadBindingManager = {
    accountId: string;
    shouldPersistMutations: () => boolean;
    getIdleTimeoutMs: () => number;
    getMaxAgeMs: () => number;
    getByConversationId: (conversationId: string) => TelegramThreadBindingRecord | undefined;
    listBySessionKey: (targetSessionKey: string) => TelegramThreadBindingRecord[];
    listBindings: () => TelegramThreadBindingRecord[];
    touchConversation: (conversationId: string, at?: number) => TelegramThreadBindingRecord | null;
    unbindConversation: (params: {
        conversationId: string;
        reason?: string;
        sendFarewell?: boolean;
    }) => TelegramThreadBindingRecord | null;
    unbindBySessionKey: (params: {
        targetSessionKey: string;
        reason?: string;
        sendFarewell?: boolean;
    }) => TelegramThreadBindingRecord[];
    stop: () => void;
};
export declare function createTelegramThreadBindingManager(params?: {
    accountId?: string;
    persist?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    enableSweeper?: boolean;
}): TelegramThreadBindingManager;
export declare function getTelegramThreadBindingManager(accountId?: string): TelegramThreadBindingManager | null;
export declare function setTelegramThreadBindingIdleTimeoutBySessionKey(params: {
    targetSessionKey: string;
    accountId?: string;
    idleTimeoutMs: number;
}): TelegramThreadBindingRecord[];
export declare function setTelegramThreadBindingMaxAgeBySessionKey(params: {
    targetSessionKey: string;
    accountId?: string;
    maxAgeMs: number;
}): TelegramThreadBindingRecord[];
export declare const __testing: {
    resetTelegramThreadBindingsForTests(): void;
};
export {};
