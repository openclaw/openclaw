import type { DurableMessageSendIntent, MessageReceipt } from "./types.js";
export type DurableMessageSendState = "pending" | "sent" | "suppressed" | "failed" | "unknown_after_send";
export type DurableMessageStateRecord = {
    intent: DurableMessageSendIntent;
    state: DurableMessageSendState;
    receipt?: MessageReceipt;
    updatedAt: number;
    errorMessage?: string;
};
export declare function createDurableMessageStateRecord(params: {
    intent: DurableMessageSendIntent;
    state?: DurableMessageSendState;
    receipt?: MessageReceipt;
    updatedAt?: number;
    error?: unknown;
}): DurableMessageStateRecord;
export declare function classifyDurableSendRecoveryState(params: {
    hasIntent: boolean;
    hasReceipt: boolean;
    platformSendMayHaveStarted: boolean;
    failed?: boolean;
    suppressed?: boolean;
}): DurableMessageSendState;
