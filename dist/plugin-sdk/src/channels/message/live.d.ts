import type { LiveMessageState, MessageReceipt, RenderedMessageBatch } from "./types.js";
export type { LiveMessagePhase, LiveMessageState } from "./types.js";
export type LivePreviewFinalizerDraft<TId> = {
    flush: () => Promise<void>;
    id: () => TId | undefined;
    seal?: () => Promise<void>;
    discardPending?: () => Promise<void>;
    clear: () => Promise<void>;
};
export type LivePreviewFinalizerResultKind = "normal-delivered" | "normal-skipped" | "preview-finalized" | "preview-retained";
export type LivePreviewFinalizerResult<TPayload> = {
    kind: LivePreviewFinalizerResultKind;
    liveState?: LiveMessageState<TPayload>;
};
export type FinalizableLivePreviewAdapter<TPayload, TId, TEdit> = {
    draft?: LivePreviewFinalizerDraft<TId>;
    buildFinalEdit: (payload: TPayload) => TEdit | undefined;
    editFinal: (id: TId, edit: TEdit) => Promise<void>;
    resolveFinalizedId?: (id: TId, edit: TEdit) => TId | undefined;
    createPreviewReceipt?: (id: TId, edit: TEdit) => MessageReceipt;
    onPreviewFinalized?: (id: TId, receipt: MessageReceipt, liveState: LiveMessageState<TPayload>) => Promise<void> | void;
    buildSupplementalPayload?: (payload: TPayload) => TPayload | undefined;
    deliverSupplemental?: (payload: TPayload) => Promise<boolean | void>;
    handlePreviewEditError?: (params: {
        error: unknown;
        id: TId;
        edit: TEdit;
        payload: TPayload;
        liveState: LiveMessageState<TPayload>;
    }) => "fallback" | "retain" | Promise<"fallback" | "retain">;
    logPreviewEditFailure?: (error: unknown) => void;
};
export declare function defineFinalizableLivePreviewAdapter<TPayload, TId, TEdit>(adapter: FinalizableLivePreviewAdapter<TPayload, TId, TEdit>): FinalizableLivePreviewAdapter<TPayload, TId, TEdit>;
export declare function createLiveMessageState<TPayload = unknown>(params?: {
    receipt?: MessageReceipt;
    lastRendered?: RenderedMessageBatch<TPayload>;
    canFinalizeInPlace?: boolean;
}): LiveMessageState<TPayload>;
export declare function markLiveMessageFinalized<TPayload>(state: LiveMessageState<TPayload>, receipt: MessageReceipt): LiveMessageState<TPayload>;
export declare function createPreviewMessageReceipt(params: {
    id: unknown;
    threadId?: string;
    replyToId?: string;
    sentAt?: number;
    raw?: unknown;
}): MessageReceipt;
export declare function deliverFinalizableLivePreview<TPayload, TId, TEdit>(params: {
    kind: "tool" | "block" | "final";
    payload: TPayload;
    liveState?: LiveMessageState<TPayload>;
    draft?: LivePreviewFinalizerDraft<TId>;
    buildFinalEdit: (payload: TPayload) => TEdit | undefined;
    editFinal: (id: TId, edit: TEdit) => Promise<void>;
    resolveFinalizedId?: (id: TId, edit: TEdit) => TId | undefined;
    deliverNormally: (payload: TPayload) => Promise<boolean | void>;
    createPreviewReceipt?: (id: TId, edit: TEdit) => MessageReceipt;
    onPreviewFinalized?: (id: TId, receipt: MessageReceipt, liveState: LiveMessageState<TPayload>) => Promise<void> | void;
    buildSupplementalPayload?: (payload: TPayload) => TPayload | undefined;
    deliverSupplemental?: (payload: TPayload) => Promise<boolean | void>;
    handlePreviewEditError?: (params: {
        error: unknown;
        id: TId;
        edit: TEdit;
        payload: TPayload;
        liveState: LiveMessageState<TPayload>;
    }) => "fallback" | "retain" | Promise<"fallback" | "retain">;
    onNormalDelivered?: () => Promise<void> | void;
    logPreviewEditFailure?: (error: unknown) => void;
}): Promise<LivePreviewFinalizerResult<TPayload>>;
export declare function deliverWithFinalizableLivePreviewAdapter<TPayload, TId, TEdit>(params: {
    kind: "tool" | "block" | "final";
    payload: TPayload;
    liveState?: LiveMessageState<TPayload>;
    adapter?: FinalizableLivePreviewAdapter<TPayload, TId, TEdit>;
    deliverNormally: (payload: TPayload) => Promise<boolean | void>;
    onNormalDelivered?: () => Promise<void> | void;
}): Promise<LivePreviewFinalizerResult<TPayload>>;
export declare function markLiveMessagePreviewUpdated<TPayload>(state: LiveMessageState<TPayload>, rendered: RenderedMessageBatch<TPayload>): LiveMessageState<TPayload>;
export declare function markLiveMessageCancelled<TPayload>(state: LiveMessageState<TPayload>): LiveMessageState<TPayload>;
