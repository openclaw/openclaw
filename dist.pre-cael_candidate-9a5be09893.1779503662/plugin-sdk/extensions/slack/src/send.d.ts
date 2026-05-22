import type { MessageMetadata } from "@slack/types";
import { type Block, type KnownBlock, type WebClient } from "@slack/web-api";
import { type MessageReceipt } from "openclaw/plugin-sdk/channel-message";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export type SlackSendIdentity = {
    username?: string;
    iconUrl?: string;
    iconEmoji?: string;
};
type SlackSendOpts = {
    cfg: OpenClawConfig;
    token?: string;
    accountId?: string;
    mediaUrl?: string;
    mediaAccess?: {
        localRoots?: readonly string[];
        readFile?: (filePath: string) => Promise<Buffer>;
    };
    uploadFileName?: string;
    uploadTitle?: string;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    client?: WebClient;
    threadTs?: string;
    replyBroadcast?: boolean;
    identity?: SlackSendIdentity;
    blocks?: (Block | KnownBlock)[];
    metadata?: MessageMetadata;
};
export type SlackSendResult = {
    messageId: string;
    channelId: string;
    receipt: MessageReceipt;
};
export declare function clearSlackDmChannelCache(): void;
export declare function clearSlackSendQueuesForTest(): void;
export declare function sendMessageSlack(to: string, message: string, opts: SlackSendOpts): Promise<SlackSendResult>;
export {};
