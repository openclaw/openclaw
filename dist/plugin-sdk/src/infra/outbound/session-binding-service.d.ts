import type { ConversationRef, SessionBindingBindInput, SessionBindingCapabilities, SessionBindingErrorCode, SessionBindingPlacement, SessionBindingRecord, SessionBindingUnbindInput } from "./session-binding.types.js";
export type { BindingStatus, BindingTargetKind, ConversationRef, SessionBindingBindInput, SessionBindingCapabilities, SessionBindingErrorCode, SessionBindingPlacement, SessionBindingRecord, SessionBindingUnbindInput, } from "./session-binding.types.js";
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
    adapter?: SessionBindingAdapter;
}): void;
export declare function getSessionBindingService(): SessionBindingService;
export declare const __testing: {
    resetSessionBindingAdaptersForTests(): void;
    getRegisteredAdapterKeys(): string[];
};
