import { createScopedAccountConfigAccessors } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildAccountScopedDmSecurityPolicy,
  collectAllowlistProviderRestrictSendersWarnings,
} from "openclaw/plugin-sdk/channel-policy";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  getChatChannelMeta,
  normalizeE164,
  setAccountEnabledInConfigSection,
  SignalConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/signal-core";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  type ResolvedSignalAccount,
} from "./accounts.js";
import { createSignalSetupWizardProxy } from "./setup-core.js";

export const SIGNAL_CHANNEL = "signal" as const;

async function loadSignalChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const signalSetupWizard = createSignalSetupWizardProxy(async () => ({
  signalSetupWizard: (await loadSignalChannelRuntime()).signalSetupWizard,
}));

export const signalConfigAccessors = createScopedAccountConfigAccessors({
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

export function createSignalPluginBase(params: {
  setupWizard?: NonNullable<ChannelPlugin<ResolvedSignalAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedSignalAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedSignalAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "streaming"
  | "reload"
  | "configSchema"
  | "config"
  | "security"
  | "setup"
> {
  return {
    id: SIGNAL_CHANNEL,
    meta: {
      ...getChatChannelMeta(SIGNAL_CHANNEL),
    },
    setupWizard: params.setupWizard,
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
          sectionKey: SIGNAL_CHANNEL,
          accountId,
          enabled,
          allowTopLevel: true,
        }),
      deleteAccount: ({ cfg, accountId }) =>
        deleteAccountFromConfigSection({
          cfg,
          sectionKey: SIGNAL_CHANNEL,
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
          channelKey: SIGNAL_CHANNEL,
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
    setup: params.setup,
  };
}
