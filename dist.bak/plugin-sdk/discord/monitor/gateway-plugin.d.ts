import { GatewayPlugin } from "@buape/carbon/gateway";
import type { DiscordAccountConfig } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
export declare function resolveDiscordGatewayIntents(intentsConfig?: import("../../config/types.discord.js").DiscordIntentsConfig): number;
export declare function createDiscordGatewayPlugin(params: {
    discordConfig: DiscordAccountConfig;
    runtime: RuntimeEnv;
}): GatewayPlugin;
