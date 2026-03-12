import type { ReplyToMode } from "../../config/types.js";
export type ReplyReferencePlanner = {
    /** Returns the effective reply/thread id for the next send and updates state. */
    use(): string | undefined;
    /** Mark that a reply was sent (needed when no reference is used). */
    markSent(): void;
    /** Whether a reply has been sent in this flow. */
    hasReplied(): boolean;
};
export declare function createReplyReferencePlanner(options: {
    replyToMode: ReplyToMode;
    /** Existing thread/reference id (preferred when allowed by replyToMode). */
    existingId?: string;
    /** Id to start a new thread/reference when allowed (e.g., parent message id). */
    startId?: string;
    /** Disable reply references entirely (e.g., when posting inside a new thread). */
    allowReference?: boolean;
    /** Seed the planner with prior reply state. */
    hasReplied?: boolean;
}): ReplyReferencePlanner;
