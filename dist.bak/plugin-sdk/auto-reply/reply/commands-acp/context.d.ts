import type { HandleCommandsParams } from "../commands-types.js";
export declare function resolveAcpCommandChannel(params: HandleCommandsParams): string;
export declare function resolveAcpCommandAccountId(params: HandleCommandsParams): string;
export declare function resolveAcpCommandThreadId(params: HandleCommandsParams): string | undefined;
export declare function resolveAcpCommandConversationId(params: HandleCommandsParams): string | undefined;
export declare function isAcpCommandDiscordChannel(params: HandleCommandsParams): boolean;
export declare function resolveAcpCommandBindingContext(params: HandleCommandsParams): {
    channel: string;
    accountId: string;
    threadId?: string;
    conversationId?: string;
};
