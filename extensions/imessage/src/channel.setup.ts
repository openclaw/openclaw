import {
  buildAccountScopedDmSecurityPolicy,
  collectAllowlistProviderRestrictSendersWarnings,
} from "openclaw/plugin-sdk/compat";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatTrimmedAllowFromEntries,
  getChatChannelMeta,
  IMessageConfigSchema,
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/imessage";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  type ResolvedIMessageAccount,
} from "./accounts.js";
import { createIMessageSetupWizardProxy, imessageSetupAdapter } from "./setup-core.js";

async function loadIMessageChannelRuntime() {
  return await import("./channel.runtime.js");
}

const imessageSetupWizard = createIMessageSetupWizardProxy(async () => ({
  imessageSetupWizard: (await loadIMessageChannelRuntime()).imessageSetupWizard,
}));

export const imessageSetupPlugin: ChannelPlugin<ResolvedIMessageAccount> = {
  id: "imessage",
  meta: {
    ...getChatChannelMeta("imessage"),
    aliases: ["imsg"],
    showConfigured: false,
  },
  setupWizard: imessageSetupWizard,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["channels.imessage"] },
  configSchema: buildChannelConfigSchema(IMessageConfigSchema),
  config: {
    listAccountIds: (cfg) => listIMessageAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveIMessageAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultIMessageAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "imessage",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "imessage",
        accountId,
        clearBaseFields: ["cliPath", "dbPath", "service", "region", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveIMessageConfigAllowFrom({ cfg, accountId }),
    formatAllowFrom: ({ allowFrom }) => formatTrimmedAllowFromEntries(allowFrom),
    resolveDefaultTo: ({ cfg, accountId }) => resolveIMessageConfigDefaultTo({ cfg, accountId }),
  },
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
  setup: imessageSetupAdapter,
};
