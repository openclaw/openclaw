import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "../../../src/channels/plugins/setup-helpers.js";
import type { ChannelSetupAdapter } from "../../../src/channels/plugins/types.adapters.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";

const channel = "zalouser" as const;

export const zalouserSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: () => null,
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
          })
        : namedConfig;
    return applySetupAccountConfigPatch({
      cfg: next,
      channelKey: channel,
      accountId,
      patch: {},
    });
  },
};
