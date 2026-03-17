import {
  buildAccountScopedDmSecurityPolicy,
  collectAllowlistProviderRestrictSendersWarnings,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { DEFAULT_ACCOUNT_ID, type ChannelPlugin } from "openclaw/plugin-sdk/imessage";
import { resolveIMessageAccount, type ResolvedIMessageAccount } from "./accounts.js";
import { imessageSetupAdapter } from "./setup-core.js";
import { createIMessagePluginBase, imessageSetupWizard } from "./shared.js";

export const imessageSetupPlugin: ChannelPlugin<ResolvedIMessageAccount> = {
  ...createIMessagePluginBase({
    setupWizard: imessageSetupWizard,
    setup: imessageSetupAdapter,
  }),
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) =>
      buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "imessage",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
      }),
    collectWarnings: ({ account, cfg }) =>
      collectAllowlistProviderRestrictSendersWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.imessage !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        surface: "iMessage groups",
        openScope: "any member",
        groupPolicyPath: "channels.imessage.groupPolicy",
        groupAllowFromPath: "channels.imessage.groupAllowFrom",
        mentionGated: false,
      }),
  },
};
