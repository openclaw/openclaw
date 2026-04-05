import { DEFAULT_ACCOUNT_ID, type ChannelSetupAdapter } from "mullusi/plugin-sdk/setup";

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
