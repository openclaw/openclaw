import { buildChannelOnboardingAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { feishuPlugin } from "./channel.js";

export const feishuOnboardingAdapter = buildChannelOnboardingAdapterFromSetupWizard({
  plugin: feishuPlugin,
  wizard: feishuPlugin.setupWizard!,
});
