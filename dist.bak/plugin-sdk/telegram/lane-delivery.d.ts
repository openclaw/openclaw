import type { ReplyPayload } from "../auto-reply/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramDraftStream } from "./draft-stream.js";
export type LaneName = "answer" | "reasoning";
export type DraftLaneState = {
    stream: TelegramDraftStream | undefined;
    lastPartialText: string;
    hasStreamedMessage: boolean;
};
export type ArchivedPreview = {
    messageId: number;
    textSnapshot: string;
};
export type LaneDeliveryResult = "preview-finalized" | "preview-updated" | "sent" | "skipped";
export type LaneDeliverySnapshot = {
    delivered: boolean;
    skippedNonSilent: number;
    failedNonSilent: number;
};
export type LaneDeliveryStateTracker = {
    markDelivered: () => void;
    markNonSilentSkip: () => void;
    markNonSilentFailure: () => void;
    snapshot: () => LaneDeliverySnapshot;
};
export declare function createLaneDeliveryStateTracker(): LaneDeliveryStateTracker;
type CreateLaneTextDelivererParams = {
    lanes: Record<LaneName, DraftLaneState>;
    archivedAnswerPreviews: ArchivedPreview[];
    finalizedPreviewByLane: Record<LaneName, boolean>;
    draftMaxChars: number;
    applyTextToPayload: (payload: ReplyPayload, text: string) => ReplyPayload;
    sendPayload: (payload: ReplyPayload) => Promise<boolean>;
    flushDraftLane: (lane: DraftLaneState) => Promise<void>;
    stopDraftLane: (lane: DraftLaneState) => Promise<void>;
    editPreview: (params: {
        laneName: LaneName;
        messageId: number;
        text: string;
        context: "final" | "update";
        previewButtons?: TelegramInlineButtons;
    }) => Promise<void>;
    deletePreviewMessage: (messageId: number) => Promise<void>;
    log: (message: string) => void;
    markDelivered: () => void;
};
type DeliverLaneTextParams = {
    laneName: LaneName;
    text: string;
    payload: ReplyPayload;
    infoKind: string;
    previewButtons?: TelegramInlineButtons;
    allowPreviewUpdateForNonFinal?: boolean;
};
export declare function createLaneTextDeliverer(params: CreateLaneTextDelivererParams): ({ laneName, text, payload, infoKind, previewButtons, allowPreviewUpdateForNonFinal, }: DeliverLaneTextParams) => Promise<LaneDeliveryResult>;
export {};
