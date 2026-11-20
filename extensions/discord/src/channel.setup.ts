import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedDiscordAccount } from "./accounts.js";
import { discordSetupContract } from "./setup-adapter.js";
import { discordSetupWizard } from "./setup-core.js";
import { createDiscordPluginBase } from "./shared.js";

export const discordSetupPlugin: ChannelPlugin<ResolvedDiscordAccount> = {
  ...createDiscordPluginBase({
    setupWizard: discordSetupWizard,
    setupContract: discordSetupContract,
  }),
};
