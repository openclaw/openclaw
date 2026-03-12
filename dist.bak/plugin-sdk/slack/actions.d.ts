import type { Block, KnownBlock, WebClient } from "@slack/web-api";
export type SlackActionClientOpts = {
    accountId?: string;
    token?: string;
    client?: WebClient;
};
export type SlackMessageSummary = {
    ts?: string;
    text?: string;
    user?: string;
    thread_ts?: string;
    reply_count?: number;
    reactions?: Array<{
        name?: string;
        count?: number;
        users?: string[];
    }>;
};
export type SlackPin = {
    type?: string;
    message?: {
        ts?: string;
        text?: string;
    };
    file?: {
        id?: string;
        name?: string;
    };
};
export declare function reactSlackMessage(channelId: string, messageId: string, emoji: string, opts?: SlackActionClientOpts): Promise<void>;
export declare function removeSlackReaction(channelId: string, messageId: string, emoji: string, opts?: SlackActionClientOpts): Promise<void>;
export declare function removeOwnSlackReactions(channelId: string, messageId: string, opts?: SlackActionClientOpts): Promise<string[]>;
export declare function listSlackReactions(channelId: string, messageId: string, opts?: SlackActionClientOpts): Promise<SlackMessageSummary["reactions"]>;
export declare function sendSlackMessage(to: string, content: string, opts?: SlackActionClientOpts & {
    mediaUrl?: string;
    threadTs?: string;
    blocks?: (Block | KnownBlock)[];
}): Promise<import("./send.js").SlackSendResult>;
export declare function editSlackMessage(channelId: string, messageId: string, content: string, opts?: SlackActionClientOpts & {
    blocks?: (Block | KnownBlock)[];
}): Promise<void>;
export declare function deleteSlackMessage(channelId: string, messageId: string, opts?: SlackActionClientOpts): Promise<void>;
export declare function readSlackMessages(channelId: string, opts?: SlackActionClientOpts & {
    limit?: number;
    before?: string;
    after?: string;
    threadId?: string;
}): Promise<{
    messages: SlackMessageSummary[];
    hasMore: boolean;
}>;
export declare function getSlackMemberInfo(userId: string, opts?: SlackActionClientOpts): Promise<import("@slack/web-api").UsersInfoResponse>;
export declare function listSlackEmojis(opts?: SlackActionClientOpts): Promise<import("@slack/web-api").EmojiListResponse>;
export declare function pinSlackMessage(channelId: string, messageId: string, opts?: SlackActionClientOpts): Promise<void>;
export declare function unpinSlackMessage(channelId: string, messageId: string, opts?: SlackActionClientOpts): Promise<void>;
export declare function listSlackPins(channelId: string, opts?: SlackActionClientOpts): Promise<SlackPin[]>;
