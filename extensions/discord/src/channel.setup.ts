import {
  buildChannelConfigSchema,
  DiscordConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/discord";
import { type ResolvedDiscordAccount } from "./accounts.js";
import { discordSetupAdapter } from "./setup-core.js";
import { createDiscordPluginBase } from "./shared.js";

export const discordSetupPlugin: ChannelPlugin<ResolvedDiscordAccount> = {
  ...createDiscordPluginBase({
    configSchema: buildChannelConfigSchema(DiscordConfigSchema),
    setup: discordSetupAdapter,
  }),
};
