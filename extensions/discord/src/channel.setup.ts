import { type ResolvedDiscordAccount } from "./accounts.js";
import { type ChannelPlugin } from "./runtime-api.js";
import { discordSetupAdapter } from "./setup-core.js";
import { createDiscordPluginBase } from "./shared.js";

export const discordSetupPlugin: ChannelPlugin<ResolvedDiscordAccount> = {
  ...createDiscordPluginBase({
    setup: discordSetupAdapter,
  }),
};
