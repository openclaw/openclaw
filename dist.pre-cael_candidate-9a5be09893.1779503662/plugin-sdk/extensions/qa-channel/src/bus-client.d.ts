import type { QaBusInboundMessageInput, QaBusMessage, QaBusPollResult, QaBusSearchMessagesInput, QaBusStateSnapshot, QaBusThread, QaBusToolCall } from "./protocol.js";
export type { QaBusAttachment, QaBusConversation, QaBusConversationKind, QaBusCreateThreadInput, QaBusDeleteMessageInput, QaBusEditMessageInput, QaBusEvent, QaBusInboundMessageInput, QaBusMessage, QaBusOutboundMessageInput, QaBusPollInput, QaBusPollResult, QaBusReactToMessageInput, QaBusReadMessageInput, QaBusSearchMessagesInput, QaBusStateSnapshot, QaBusThread, QaBusToolCall, QaBusWaitForInput, } from "./protocol.js";
export declare function normalizeQaTarget(raw: string): string | undefined;
export declare function parseQaTarget(raw: string): {
    chatType: "direct" | "channel" | "group";
    conversationId: string;
    threadId?: string;
};
export declare function buildQaTarget(params: {
    chatType: "direct" | "channel" | "group";
    conversationId: string;
    threadId?: string | null;
}): string;
export declare function pollQaBus(params: {
    baseUrl: string;
    accountId: string;
    cursor: number;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<QaBusPollResult>;
export declare function sendQaBusMessage(params: {
    baseUrl: string;
    accountId: string;
    to: string;
    text: string;
    senderId?: string;
    senderName?: string;
    threadId?: string;
    replyToId?: string;
    attachments?: import("./protocol.js").QaBusAttachment[];
    toolCalls?: QaBusToolCall[];
}): Promise<{
    message: QaBusMessage;
}>;
export declare function createQaBusThread(params: {
    baseUrl: string;
    accountId: string;
    conversationId: string;
    title: string;
    createdBy?: string;
}): Promise<{
    thread: QaBusThread;
}>;
export declare function reactToQaBusMessage(params: {
    baseUrl: string;
    accountId: string;
    messageId: string;
    emoji: string;
    senderId?: string;
}): Promise<{
    message: QaBusMessage;
}>;
export declare function editQaBusMessage(params: {
    baseUrl: string;
    accountId: string;
    messageId: string;
    text: string;
}): Promise<{
    message: QaBusMessage;
}>;
export declare function deleteQaBusMessage(params: {
    baseUrl: string;
    accountId: string;
    messageId: string;
}): Promise<{
    message: QaBusMessage;
}>;
export declare function readQaBusMessage(params: {
    baseUrl: string;
    accountId: string;
    messageId: string;
}): Promise<{
    message: QaBusMessage;
}>;
export declare function searchQaBusMessages(params: {
    baseUrl: string;
    input: QaBusSearchMessagesInput;
}): Promise<{
    messages: QaBusMessage[];
}>;
export declare function injectQaBusInboundMessage(params: {
    baseUrl: string;
    input: QaBusInboundMessageInput;
}): Promise<{
    message: QaBusMessage;
}>;
export declare function getQaBusState(baseUrl: string): Promise<QaBusStateSnapshot>;
