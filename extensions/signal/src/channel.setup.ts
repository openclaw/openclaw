// Signal plugin module implements channel.setup behavior.
import { getChatChannelMeta, type ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import type { ResolvedSignalAccount } from "./accounts.js";
import { signalSetupAdapter } from "./setup-core.js";
import { signalSetupWizard } from "./setup-surface.js";
import { signalConfigAdapter } from "./shared.js";

export const signalSetupPlugin: ChannelPlugin<ResolvedSignalAccount> = {
  id: "signal",
  meta: {
    ...getChatChannelMeta("signal"),
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
  },
  setupWizard: signalSetupWizard,
  config: {
    ...signalConfigAdapter,
    isConfigured: (account) => account.configured,
  },
  setup: signalSetupAdapter,
};
