import { buildChannelSetupFlowAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { feishuPlugin } from "./channel.js";

export const feishuOnboardingAdapter = buildChannelSetupFlowAdapterFromSetupWizard({
  plugin: feishuPlugin,
  wizard: feishuPlugin.setupWizard!,
});
