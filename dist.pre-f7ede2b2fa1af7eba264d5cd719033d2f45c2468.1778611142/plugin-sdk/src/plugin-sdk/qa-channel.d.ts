import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { QaBusAttachment, QaBusInboundMessageInput, QaBusMessage, QaBusPollResult, QaBusSearchMessagesInput, QaBusStateSnapshot, QaBusThread } from "./qa-channel-protocol.js";
export type * from "./qa-channel-protocol.js";
type QaTargetParts = {
    chatType: "direct" | "channel";
    conversationId: string;
    threadId?: string;
};
type FacadeModule = {
    buildQaTarget: (params: QaTargetParts & {
        threadId?: string | null;
    }) => string;
    formatQaTarget: (params: QaTargetParts & {
        threadId?: string | null;
    }) => string;
    createQaBusThread: (params: {
        baseUrl: string;
        accountId: string;
        conversationId: string;
        title: string;
        createdBy?: string;
    }) => Promise<{
        thread: QaBusThread;
    }>;
    deleteQaBusMessage: (params: {
        baseUrl: string;
        accountId: string;
        messageId: string;
    }) => Promise<{
        message: QaBusMessage;
    }>;
    editQaBusMessage: (params: {
        baseUrl: string;
        accountId: string;
        messageId: string;
        text: string;
    }) => Promise<{
        message: QaBusMessage;
    }>;
    getQaBusState: (baseUrl: string) => Promise<QaBusStateSnapshot>;
    injectQaBusInboundMessage: (params: {
        baseUrl: string;
        input: QaBusInboundMessageInput;
    }) => Promise<{
        message: QaBusMessage;
    }>;
    normalizeQaTarget: (raw: string) => string | undefined;
    parseQaTarget: (raw: string) => QaTargetParts;
    pollQaBus: (params: {
        baseUrl: string;
        accountId: string;
        cursor: number;
        timeoutMs: number;
        signal?: AbortSignal;
    }) => Promise<QaBusPollResult>;
    qaChannelPlugin: ChannelPlugin;
    reactToQaBusMessage: (params: {
        baseUrl: string;
        accountId: string;
        messageId: string;
        emoji: string;
        senderId?: string;
    }) => Promise<{
        message: QaBusMessage;
    }>;
    readQaBusMessage: (params: {
        baseUrl: string;
        accountId: string;
        messageId: string;
    }) => Promise<{
        message: QaBusMessage;
    }>;
    searchQaBusMessages: (params: {
        baseUrl: string;
        input: QaBusSearchMessagesInput;
    }) => Promise<{
        messages: QaBusMessage[];
    }>;
    sendQaBusMessage: (params: {
        baseUrl: string;
        accountId: string;
        to: string;
        text: string;
        senderId?: string;
        senderName?: string;
        threadId?: string;
        replyToId?: string;
        attachments?: QaBusAttachment[];
    }) => Promise<{
        message: QaBusMessage;
    }>;
    setQaChannelRuntime: (runtime: unknown) => void;
};
export declare const buildQaTarget: FacadeModule["buildQaTarget"];
export declare const formatQaTarget: FacadeModule["buildQaTarget"];
export declare const createQaBusThread: FacadeModule["createQaBusThread"];
export declare const deleteQaBusMessage: FacadeModule["deleteQaBusMessage"];
export declare const editQaBusMessage: FacadeModule["editQaBusMessage"];
export declare const getQaBusState: FacadeModule["getQaBusState"];
export declare const injectQaBusInboundMessage: FacadeModule["injectQaBusInboundMessage"];
export declare const normalizeQaTarget: FacadeModule["normalizeQaTarget"];
export declare const parseQaTarget: FacadeModule["parseQaTarget"];
export declare const pollQaBus: FacadeModule["pollQaBus"];
export declare const qaChannelPlugin: FacadeModule["qaChannelPlugin"];
export declare const reactToQaBusMessage: FacadeModule["reactToQaBusMessage"];
export declare const readQaBusMessage: FacadeModule["readQaBusMessage"];
export declare const searchQaBusMessages: FacadeModule["searchQaBusMessages"];
export declare const sendQaBusMessage: FacadeModule["sendQaBusMessage"];
export declare const setQaChannelRuntime: FacadeModule["setQaChannelRuntime"];
