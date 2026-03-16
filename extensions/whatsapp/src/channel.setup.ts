import {
  buildAccountScopedDmSecurityPolicy,
  buildChannelConfigSchema,
  collectAllowlistProviderGroupPolicyWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  DEFAULT_ACCOUNT_ID,
  formatWhatsAppConfigAllowFromEntries,
  getChatChannelMeta,
  normalizeE164,
  resolveWhatsAppConfigAllowFrom,
  resolveWhatsAppConfigDefaultTo,
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
  WhatsAppConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/whatsapp";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  type ResolvedWhatsAppAccount,
} from "./accounts.js";
import { webAuthExists } from "./auth-store.js";
import { whatsappSetupAdapter } from "./setup-core.js";

async function loadWhatsAppChannelRuntime() {
  return await import("./channel.runtime.js");
}

const whatsappSetupWizardProxy = {
  channel: "whatsapp",
  status: {
    configuredLabel: "linked",
    unconfiguredLabel: "not linked",
    configuredHint: "linked",
    unconfiguredHint: "not linked",
    configuredScore: 5,
    unconfiguredScore: 4,
    resolveConfigured: async ({ cfg }) =>
      await (
        await loadWhatsAppChannelRuntime()
      ).whatsappSetupWizard.status.resolveConfigured({
        cfg,
      }),
    resolveStatusLines: async ({ cfg, configured }) =>
      (await (
        await loadWhatsAppChannelRuntime()
      ).whatsappSetupWizard.status.resolveStatusLines?.({
        cfg,
        configured,
      })) ?? [],
  },
  resolveShouldPromptAccountIds: (params) =>
    (params.shouldPromptAccountIds || params.options?.promptWhatsAppAccountId) ?? false,
  credentials: [],
  finalize: async (params) =>
    await (
      await loadWhatsAppChannelRuntime()
    ).whatsappSetupWizard.finalize!(params),
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      whatsapp: {
        ...cfg.channels?.whatsapp,
        enabled: false,
      },
    },
  }),
  onAccountRecorded: (accountId, options) => {
    options?.onWhatsAppAccountId?.(accountId);
  },
} satisfies NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]>;

export const whatsappSetupPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  id: "whatsapp",
  meta: {
    ...getChatChannelMeta("whatsapp"),
    showConfigured: false,
    quickstartAllowFrom: true,
    forceAccountBinding: true,
    preferSessionLookupForAnnounceTarget: true,
  },
  setupWizard: whatsappSetupWizardProxy,
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: true,
    reactions: true,
    media: true,
  },
  reload: { configPrefixes: ["web"], noopPrefixes: ["channels.whatsapp"] },
  gatewayMethods: ["web.login.start", "web.login.wait"],
  configSchema: buildChannelConfigSchema(WhatsAppConfigSchema),
  config: {
    listAccountIds: (cfg) => listWhatsAppAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWhatsAppAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const accounts = { ...cfg.channels?.whatsapp?.accounts };
      const existing = accounts[accountKey] ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          whatsapp: {
            ...cfg.channels?.whatsapp,
            accounts: {
              ...accounts,
              [accountKey]: {
                ...existing,
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const accounts = { ...cfg.channels?.whatsapp?.accounts };
      delete accounts[accountKey];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          whatsapp: {
            ...cfg.channels?.whatsapp,
            accounts: Object.keys(accounts).length ? accounts : undefined,
          },
        },
      };
    },
    isEnabled: (account, cfg) => account.enabled && cfg.web?.enabled !== false,
    disabledReason: () => "disabled",
    isConfigured: async (account) => await webAuthExists(account.authDir),
    unconfiguredReason: () => "not linked",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.authDir),
      linked: Boolean(account.authDir),
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveWhatsAppConfigAllowFrom({ cfg, accountId }),
    formatAllowFrom: ({ allowFrom }) => formatWhatsAppConfigAllowFromEntries(allowFrom),
    resolveDefaultTo: ({ cfg, accountId }) => resolveWhatsAppConfigDefaultTo({ cfg, accountId }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) =>
      buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "whatsapp",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.dmPolicy,
        allowFrom: account.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
        normalizeEntry: (raw) => normalizeE164(raw),
      }),
    collectWarnings: ({ account, cfg }) => {
      const groupAllowlistConfigured =
        Boolean(account.groups) && Object.keys(account.groups ?? {}).length > 0;
      return collectAllowlistProviderGroupPolicyWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.whatsapp !== undefined,
        configuredGroupPolicy: account.groupPolicy,
        collect: (groupPolicy) =>
          collectOpenGroupPolicyRouteAllowlistWarnings({
            groupPolicy,
            routeAllowlistConfigured: groupAllowlistConfigured,
            restrictSenders: {
              surface: "WhatsApp groups",
              openScope: "any member in allowed groups",
              groupPolicyPath: "channels.whatsapp.groupPolicy",
              groupAllowFromPath: "channels.whatsapp.groupAllowFrom",
            },
            noRouteAllowlist: {
              surface: "WhatsApp groups",
              routeAllowlistPath: "channels.whatsapp.groups",
              routeScope: "group",
              groupPolicyPath: "channels.whatsapp.groupPolicy",
              groupAllowFromPath: "channels.whatsapp.groupAllowFrom",
            },
          }),
      });
    },
  },
  setup: whatsappSetupAdapter,
  groups: {
    resolveRequireMention: resolveWhatsAppGroupRequireMention,
    resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
    resolveGroupIntroHint: resolveWhatsAppGroupIntroHint,
  },
};
