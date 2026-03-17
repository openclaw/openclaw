import { type ChannelPlugin } from "openclaw/plugin-sdk/slack";
import { type ResolvedSlackAccount } from "./accounts.js";
import { createSlackSetupWizardProxy, slackSetupAdapter } from "./setup-core.js";
import { createSlackPluginBase } from "./shared.js";

async function loadSlackChannelRuntime() {
  return await import("./channel.runtime.js");
}

const slackSetupWizard = createSlackSetupWizardProxy(async () => ({
  slackSetupWizard: (await loadSlackChannelRuntime()).slackSetupWizard,
}));

export const slackSetupPlugin: ChannelPlugin<ResolvedSlackAccount> = {
  ...createSlackPluginBase({
    setupWizard: slackSetupWizard,
    setup: slackSetupAdapter,
  }),
};
