import type { DiscordSendResult } from "../discord/send.types.js";
type DiscordSendOptionInput = {
    replyToId?: string | null;
    accountId?: string | null;
    silent?: boolean;
};
type DiscordSendMediaOptionInput = DiscordSendOptionInput & {
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
};
export declare function buildDiscordSendOptions(input: DiscordSendOptionInput): {
    verbose: boolean;
    replyTo: string | undefined;
    accountId: string | undefined;
    silent: boolean | undefined;
};
export declare function buildDiscordSendMediaOptions(input: DiscordSendMediaOptionInput): {
    mediaUrl: string | undefined;
    mediaLocalRoots: readonly string[] | undefined;
    verbose: boolean;
    replyTo: string | undefined;
    accountId: string | undefined;
    silent: boolean | undefined;
};
export declare function tagDiscordChannelResult(result: DiscordSendResult): {
    messageId: string;
    channelId: string;
    channel: "discord";
};
export {};
