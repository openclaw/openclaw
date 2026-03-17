import {
  buildChannelConfigSchema,
  SlackConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/slack";
import { type ResolvedSlackAccount } from "./accounts.js";
import { slackSetupAdapter } from "./setup-core.js";
import { slackSetupWizard } from "./setup-surface.js";
import { createSlackPluginBase } from "./shared.js";

export const slackSetupPlugin: ChannelPlugin<ResolvedSlackAccount> = {
  ...createSlackPluginBase({
    configSchema: buildChannelConfigSchema(SlackConfigSchema),
    setupWizard: slackSetupWizard,
    setup: slackSetupAdapter,
  }),
};
