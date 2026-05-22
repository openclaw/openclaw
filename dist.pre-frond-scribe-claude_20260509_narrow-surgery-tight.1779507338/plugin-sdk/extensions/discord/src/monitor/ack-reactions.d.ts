import { createStatusReactionController, type StatusReactionAdapter } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RequestClient } from "../internal/discord.js";
import type { DiscordReactionRuntimeContext } from "../send.types.js";
export declare function createDiscordAckReactionContext(params: {
    rest: RequestClient;
    cfg: OpenClawConfig;
    accountId: string;
}): DiscordReactionRuntimeContext;
export declare function createDiscordAckReactionAdapter(params: {
    channelId: string;
    messageId: string;
    reactionContext: DiscordReactionRuntimeContext;
}): StatusReactionAdapter;
export declare function queueInitialDiscordAckReaction(params: {
    enabled: boolean;
    shouldSendAckReaction: boolean;
    ackReaction: string | undefined;
    statusReactions: ReturnType<typeof createStatusReactionController>;
    reactionAdapter: StatusReactionAdapter;
    target: string;
}): void;
