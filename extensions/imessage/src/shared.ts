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
import { createIMessageSetupWizardProxy } from "./setup-core.js";

export const IMESSAGE_CHANNEL = "imessage" as const;

async function loadIMessageChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const imessageSetupWizard = createIMessageSetupWizardProxy(async () => ({
  imessageSetupWizard: (await loadIMessageChannelRuntime()).imessageSetupWizard,
}));

export function createIMessagePluginBase(params: {
  setupWizard?: NonNullable<ChannelPlugin<ResolvedIMessageAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedIMessageAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedIMessageAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "reload"
  | "configSchema"
  | "config"
  | "security"
  | "setup"
> {
  return {
    id: IMESSAGE_CHANNEL,
    meta: {
      ...getChatChannelMeta(IMESSAGE_CHANNEL),
      aliases: ["imsg"],
      showConfigured: false,
    },
    setupWizard: params.setupWizard,
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
          sectionKey: IMESSAGE_CHANNEL,
          accountId,
          enabled,
          allowTopLevel: true,
        }),
      deleteAccount: ({ cfg, accountId }) =>
        deleteAccountFromConfigSection({
          cfg,
          sectionKey: IMESSAGE_CHANNEL,
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
          channelKey: IMESSAGE_CHANNEL,
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
    setup: params.setup,
  };
}
