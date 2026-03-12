export type BindingTargetKind = "subagent" | "session";
export type BindingStatus = "active" | "ending" | "ended";
export type SessionBindingPlacement = "current" | "child";
export type SessionBindingErrorCode = "BINDING_ADAPTER_UNAVAILABLE" | "BINDING_CAPABILITY_UNSUPPORTED" | "BINDING_CREATE_FAILED";
export type ConversationRef = {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
};
export type SessionBindingRecord = {
    bindingId: string;
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversation: ConversationRef;
    status: BindingStatus;
    boundAt: number;
    expiresAt?: number;
    metadata?: Record<string, unknown>;
};
export type SessionBindingBindInput = {
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversation: ConversationRef;
    placement?: SessionBindingPlacement;
    metadata?: Record<string, unknown>;
    ttlMs?: number;
};
export type SessionBindingUnbindInput = {
    bindingId?: string;
    targetSessionKey?: string;
    reason: string;
};
export type SessionBindingCapabilities = {
    adapterAvailable: boolean;
    bindSupported: boolean;
    unbindSupported: boolean;
    placements: SessionBindingPlacement[];
};
export declare class SessionBindingError extends Error {
    readonly code: SessionBindingErrorCode;
    readonly details?: {
        channel?: string;
        accountId?: string;
        placement?: SessionBindingPlacement;
    } | undefined;
    constructor(code: SessionBindingErrorCode, message: string, details?: {
        channel?: string;
        accountId?: string;
        placement?: SessionBindingPlacement;
    } | undefined);
}
export declare function isSessionBindingError(error: unknown): error is SessionBindingError;
export type SessionBindingService = {
    bind: (input: SessionBindingBindInput) => Promise<SessionBindingRecord>;
    getCapabilities: (params: {
        channel: string;
        accountId: string;
    }) => SessionBindingCapabilities;
    listBySession: (targetSessionKey: string) => SessionBindingRecord[];
    resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
    touch: (bindingId: string, at?: number) => void;
    unbind: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};
export type SessionBindingAdapterCapabilities = {
    placements?: SessionBindingPlacement[];
    bindSupported?: boolean;
    unbindSupported?: boolean;
};
export type SessionBindingAdapter = {
    channel: string;
    accountId: string;
    capabilities?: SessionBindingAdapterCapabilities;
    bind?: (input: SessionBindingBindInput) => Promise<SessionBindingRecord | null>;
    listBySession: (targetSessionKey: string) => SessionBindingRecord[];
    resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
    touch?: (bindingId: string, at?: number) => void;
    unbind?: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};
export declare function registerSessionBindingAdapter(adapter: SessionBindingAdapter): void;
export declare function unregisterSessionBindingAdapter(params: {
    channel: string;
    accountId: string;
}): void;
export declare function getSessionBindingService(): SessionBindingService;
export declare const __testing: {
    resetSessionBindingAdaptersForTests(): void;
    getRegisteredAdapterKeys(): string[];
};
