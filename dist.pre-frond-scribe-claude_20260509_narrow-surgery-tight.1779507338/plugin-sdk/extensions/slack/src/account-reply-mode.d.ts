import type { SlackAccountConfig } from "./runtime-api.js";
type SlackReplyToMode = "off" | "first" | "all" | "batched";
type SlackReplyToModeAccount = {
    replyToMode?: SlackReplyToMode;
    replyToModeByChatType?: SlackAccountConfig["replyToModeByChatType"];
    dm?: {
        replyToMode?: SlackReplyToMode;
    };
};
export declare function resolveSlackReplyToMode(account: SlackReplyToModeAccount, chatType?: string | null): SlackReplyToMode;
export {};
