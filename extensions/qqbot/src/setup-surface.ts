import { createStandardChannelSetupStatus, setSetupChannelEnabled } from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { listQQBotAccountIds, resolveQQBotAccount } from "./config.js";
import { isAccountConfigured } from "./engine/config/resolve.js";
import { finalizeQQBotSetup } from "./setup-finalize.js";

const channel = "qqbot" as const;

export const qqbotSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "QQ Bot",
    configuredLabel: "configured",
    unconfiguredLabel: "not linked",
    configuredHint: "configured",
    unconfiguredHint: "not linked",
    configuredScore: 1,
    unconfiguredScore: 6,
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listQQBotAccountIds(cfg)).some((resolvedAccountId) => {
        const account = resolveQQBotAccount(cfg, resolvedAccountId, {
          allowUnresolvedSecretRef: true,
        });
        return isAccountConfigured(account as never);
      }),
  }),
  credentials: [],
  finalize: async ({ cfg, accountId, forceAllowFrom, prompter, runtime }) =>
    await finalizeQQBotSetup({ cfg, accountId, forceAllowFrom, prompter, runtime }),
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
