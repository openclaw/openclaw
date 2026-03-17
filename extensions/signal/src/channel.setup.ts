import {
  buildChannelConfigSchema,
  SignalConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/signal";
import { type ResolvedSignalAccount } from "./accounts.js";
import { signalSetupAdapter } from "./setup-core.js";
import { createSignalPluginBase, signalSetupWizard } from "./shared.js";

export const signalSetupPlugin: ChannelPlugin<ResolvedSignalAccount> = {
  ...createSignalPluginBase({
    configSchema: buildChannelConfigSchema(SignalConfigSchema),
    setupWizard: signalSetupWizard,
    setup: signalSetupAdapter,
  }),
};
