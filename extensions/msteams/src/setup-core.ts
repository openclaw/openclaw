import type { ChannelSetupAdapter } from "../../../src/channels/plugins/types.adapters.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";

export const msteamsSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
  applyAccountConfig: ({ cfg }) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        enabled: true,
      },
    },
  }),
};
