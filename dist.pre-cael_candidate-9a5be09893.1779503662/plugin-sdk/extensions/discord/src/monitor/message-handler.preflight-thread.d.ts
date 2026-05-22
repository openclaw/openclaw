import type { ChannelType } from "../internal/discord.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
import type { DiscordChannelInfo } from "./message-utils.js";
type DiscordPreflightThreadContext = {
    earlyThreadChannel: DiscordMessagePreflightContext["threadChannel"];
    earlyThreadParentId?: string;
    earlyThreadParentName?: string;
    earlyThreadParentType?: ChannelType;
};
export declare function resolveDiscordPreflightThreadContext(params: {
    client: DiscordMessagePreflightContext["client"];
    isGuildMessage: boolean;
    message: DiscordMessagePreflightContext["message"];
    channelInfo: DiscordChannelInfo | null;
    messageChannelId: string;
    abortSignal?: AbortSignal;
}): Promise<DiscordPreflightThreadContext | null>;
export {};
