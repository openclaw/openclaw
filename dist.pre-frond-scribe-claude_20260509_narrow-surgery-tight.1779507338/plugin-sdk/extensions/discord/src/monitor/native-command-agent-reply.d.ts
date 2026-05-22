import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import type { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { ButtonInteraction, CommandInteraction, StringSelectMenuInteraction } from "../internal/discord.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import type { buildDiscordNativeCommandContext } from "./native-command-context.js";
import type { DiscordConfig } from "./native-command.types.js";
type NativeCommandEffectiveRoute = {
    accountId: string;
    agentId: string;
};
export declare function dispatchDiscordNativeAgentReply(params: {
    cfg: OpenClawConfig;
    discordConfig: DiscordConfig;
    accountId: string;
    interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
    ctxPayload: ReturnType<typeof buildDiscordNativeCommandContext>;
    effectiveRoute: NativeCommandEffectiveRoute;
    channelConfig: DiscordChannelConfigResolved | null;
    mediaLocalRoots: ReturnType<typeof getAgentScopedMediaLocalRoots>;
    preferFollowUp: boolean;
    responseEphemeral?: boolean;
    suppressReplies?: boolean;
    log: ReturnType<typeof createSubsystemLogger>;
}): Promise<void>;
export {};
