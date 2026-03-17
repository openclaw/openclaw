import { createPatchedAccountSetupAdapter } from "../../../src/channels/plugins/setup-helpers.js";
import type { ChannelSetupAdapter } from "../../../src/plugin-sdk-internal/setup.js";

const channel = "whatsapp" as const;

export const whatsappSetupAdapter: ChannelSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  alwaysUseAccounts: true,
  buildPatch: (input) => ({
    ...(input.authDir ? { authDir: input.authDir } : {}),
  }),
});
