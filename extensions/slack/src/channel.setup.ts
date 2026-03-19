import { type ResolvedSlackAccount } from "./accounts.js";
import { type ChannelPlugin } from "./runtime-api.js";
import { slackSetupAdapter } from "./setup-core.js";
import { slackSetupWizard } from "./setup-surface.js";
import { createSlackPluginBase } from "./shared.js";

export const slackSetupPlugin: ChannelPlugin<ResolvedSlackAccount> = {
  ...createSlackPluginBase({
    setupWizard: slackSetupWizard,
    setup: slackSetupAdapter,
  }),
};
