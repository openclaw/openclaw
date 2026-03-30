import { loadConfig } from "../config/config.js";
import { type ResolvedIMessageAccount } from "./accounts.js";
import { type IMessageRpcClient } from "./client.js";
import { type IMessageService } from "./targets.js";
export type IMessageSendOpts = {
    cliPath?: string;
    dbPath?: string;
    service?: IMessageService;
    region?: string;
    accountId?: string;
    replyToId?: string;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    maxBytes?: number;
    timeoutMs?: number;
    chatId?: number;
    client?: IMessageRpcClient;
    config?: ReturnType<typeof loadConfig>;
    account?: ResolvedIMessageAccount;
    resolveAttachmentImpl?: (mediaUrl: string, maxBytes: number, options?: {
        localRoots?: readonly string[];
    }) => Promise<{
        path: string;
        contentType?: string;
    }>;
    createClient?: (params: {
        cliPath: string;
        dbPath?: string;
    }) => Promise<IMessageRpcClient>;
};
export type IMessageSendResult = {
    messageId: string;
};
export declare function sendMessageIMessage(to: string, text: string, opts?: IMessageSendOpts): Promise<IMessageSendResult>;
