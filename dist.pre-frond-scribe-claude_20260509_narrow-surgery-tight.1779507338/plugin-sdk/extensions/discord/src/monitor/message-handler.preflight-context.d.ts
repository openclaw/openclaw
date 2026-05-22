import type { DiscordMessagePreflightContext, DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
type SharedPreflightFields = "cfg" | "discordConfig" | "accountId" | "token" | "runtime" | "botUserId" | "abortSignal" | "guildHistories" | "historyLimit" | "mediaMaxBytes" | "textLimit" | "replyToMode" | "ackReactionScope" | "groupPolicy" | "threadBindings" | "discordRestFetch";
type BuildDiscordMessagePreflightContextParams = Omit<DiscordMessagePreflightContext, SharedPreflightFields> & {
    preflightParams: DiscordMessagePreflightParams;
};
export declare function buildDiscordMessagePreflightContext({ preflightParams, ...fields }: BuildDiscordMessagePreflightContextParams): DiscordMessagePreflightContext;
export {};
