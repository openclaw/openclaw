export type DraftPreviewFinalizerDraft<TId> = {
    flush: () => Promise<void>;
    id: () => TId | undefined;
    seal?: () => Promise<void>;
    discardPending?: () => Promise<void>;
    clear: () => Promise<void>;
};
export type DraftPreviewFinalizerResult = "normal-delivered" | "normal-skipped" | "preview-finalized";
export declare function deliverFinalizableDraftPreview<TPayload, TId, TEdit>(params: {
    kind: "tool" | "block" | "final";
    payload: TPayload;
    draft?: DraftPreviewFinalizerDraft<TId>;
    buildFinalEdit: (payload: TPayload) => TEdit | undefined;
    editFinal: (id: TId, edit: TEdit) => Promise<void>;
    deliverNormally: (payload: TPayload) => Promise<boolean | void>;
    onPreviewFinalized?: (id: TId) => Promise<void> | void;
    onNormalDelivered?: () => Promise<void> | void;
    logPreviewEditFailure?: (error: unknown) => void;
}): Promise<DraftPreviewFinalizerResult>;
