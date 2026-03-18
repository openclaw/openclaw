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
  IMessageConfigSchema,
  type ChannelPlugin,
} from "../runtime-api.js";
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

export const imessageSetupWizard = createIMessageSetupWizardProxy(
  async () => (await loadIMessageChannelRuntime()).imessageSetupWizard,
);

export const imessageConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveIMessageAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedIMessageAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  resolveDefaultTo: (account: ResolvedIMessageAccount) => account.config.defaultTo,
});

export const imessageConfigBase = createScopedChannelConfigBase<ResolvedIMessageAccount>({
  sectionKey: IMESSAGE_CHANNEL,
  listAccountIds: listIMessageAccountIds,
  resolveAccount: (cfg, accountId) => resolveIMessageAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultIMessageAccountId,
  clearBaseFields: ["cliPath", "dbPath", "service", "region", "name"],
});

export const imessageResolveDmPolicy = createScopedDmSecurityResolver<ResolvedIMessageAccount>({
  channelKey: IMESSAGE_CHANNEL,
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
});

export function collectIMessageSecurityWarnings(params: {
  account: ResolvedIMessageAccount;
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
}) {
  return collectAllowlistProviderRestrictSendersWarnings({
    cfg: params.cfg,
    providerConfigPresent: params.cfg.channels?.imessage !== undefined,
    configuredGroupPolicy: params.account.config.groupPolicy,
    surface: "iMessage groups",
    openScope: "any member",
    groupPolicyPath: "channels.imessage.groupPolicy",
    groupAllowFromPath: "channels.imessage.groupAllowFrom",
    mentionGated: false,
  });
}

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
  return createChannelPluginBase({
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
      ...imessageConfigBase,
      isConfigured: (account) => account.configured,
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
      }),
      ...imessageConfigAccessors,
    },
    security: {
      resolveDmPolicy: imessageResolveDmPolicy,
      collectWarnings: collectIMessageSecurityWarnings,
    },
    setup: params.setup,
  }) as Pick<
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
  >;
}
