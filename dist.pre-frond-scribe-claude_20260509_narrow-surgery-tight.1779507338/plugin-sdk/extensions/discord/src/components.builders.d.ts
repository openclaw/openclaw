import type { DiscordComponentBuildResult, DiscordComponentMessageSpec } from "./components.types.js";
import { type TopLevelComponents } from "./internal/discord.js";
export declare function buildDiscordComponentMessage(params: {
    spec: DiscordComponentMessageSpec;
    fallbackText?: string;
    sessionKey?: string;
    agentId?: string;
    accountId?: string;
}): DiscordComponentBuildResult;
export declare function buildDiscordComponentMessageFlags(components: TopLevelComponents[]): number | undefined;
