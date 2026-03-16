import {
  createScopedAccountConfigAccessors,
  buildAccountScopedDmSecurityPolicy,
  collectAllowlistProviderRestrictSendersWarnings,
} from "openclaw/plugin-sdk/compat";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  getChatChannelMeta,
  listSignalAccountIds,
  normalizeE164,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  setAccountEnabledInConfigSection,
  SignalConfigSchema,
  type ChannelPlugin,
  type ResolvedSignalAccount,
} from "openclaw/plugin-sdk/signal";
import { createSignalSetupWizardProxy, signalSetupAdapter } from "./setup-core.js";

async function loadSignalChannelRuntime() {
  return await import("./channel.runtime.js");
}

const signalSetupWizard = createSignalSetupWizardProxy(async () => ({
  signalSetupWizard: (await loadSignalChannelRuntime()).signalSetupWizard,
}));

const signalConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveSignalAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedSignalAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => (entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))))
      .filter(Boolean),
  resolveDefaultTo: (account: ResolvedSignalAccount) => account.config.defaultTo,
});

export const signalSetupPlugin: ChannelPlugin<ResolvedSignalAccount> = {
  id: "signal",
  meta: {
    ...getChatChannelMeta("signal"),
  },
  setupWizard: signalSetupWizard,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.signal"] },
  configSchema: buildChannelConfigSchema(SignalConfigSchema),
  config: {
    listAccountIds: (cfg) => listSignalAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSignalAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "signal",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "signal",
        accountId,
        clearBaseFields: ["account", "httpUrl", "httpHost", "httpPort", "cliPath", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
    ...signalConfigAccessors,
  },
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
  setup: signalSetupAdapter,
};
