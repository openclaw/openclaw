import {
  buildAccountScopedDmSecurityPolicy,
  collectAllowlistProviderRestrictSendersWarnings,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeE164, type ChannelPlugin } from "openclaw/plugin-sdk/signal";
import { resolveSignalAccount, type ResolvedSignalAccount } from "./accounts.js";
import { signalSetupAdapter } from "./setup-core.js";
import { createSignalPluginBase, signalSetupWizard } from "./shared.js";

export const signalSetupPlugin: ChannelPlugin<ResolvedSignalAccount> = {
  ...createSignalPluginBase({
    setupWizard: signalSetupWizard,
    setup: signalSetupAdapter,
  }),
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) =>
      buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "signal",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
        normalizeEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim()),
      }),
    collectWarnings: ({ account, cfg }) =>
      collectAllowlistProviderRestrictSendersWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.signal !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        surface: "Signal groups",
        openScope: "any member",
        groupPolicyPath: "channels.signal.groupPolicy",
        groupAllowFromPath: "channels.signal.groupAllowFrom",
        mentionGated: false,
      }),
  },
};
