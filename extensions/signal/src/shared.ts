import {
  collectAllowlistProviderRestrictSendersWarnings,
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChannelPluginBase } from "openclaw/plugin-sdk/core";
import {
  buildChannelConfigSchema,
  getChatChannelMeta,
  normalizeE164,
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

export const signalSetupWizard = createSignalSetupWizardProxy(
  async () => (await loadSignalChannelRuntime()).signalSetupWizard,
);

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

export const signalConfigBase = createScopedChannelConfigBase<ResolvedSignalAccount>({
  sectionKey: SIGNAL_CHANNEL,
  listAccountIds: listSignalAccountIds,
  resolveAccount: (cfg, accountId) => resolveSignalAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultSignalAccountId,
  clearBaseFields: ["account", "httpUrl", "httpHost", "httpPort", "cliPath", "name"],
});

export const signalResolveDmPolicy = createScopedDmSecurityResolver<ResolvedSignalAccount>({
  channelKey: SIGNAL_CHANNEL,
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim()),
});

export function collectSignalSecurityWarnings(params: {
  account: ResolvedSignalAccount;
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
}) {
  return collectAllowlistProviderRestrictSendersWarnings({
    cfg: params.cfg,
    providerConfigPresent: params.cfg.channels?.signal !== undefined,
    configuredGroupPolicy: params.account.config.groupPolicy,
    surface: "Signal groups",
    openScope: "any member",
    groupPolicyPath: "channels.signal.groupPolicy",
    groupAllowFromPath: "channels.signal.groupAllowFrom",
    mentionGated: false,
  });
}

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
  return createChannelPluginBase({
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
      ...signalConfigBase,
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
      resolveDmPolicy: signalResolveDmPolicy,
      collectWarnings: collectSignalSecurityWarnings,
    },
    setup: params.setup,
  }) as Pick<
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
  >;
}
