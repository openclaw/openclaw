import {
  collectAllowlistProviderGroupPolicyWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChannelPluginBase } from "openclaw/plugin-sdk/core";
import { createDelegatedSetupWizardProxy } from "openclaw/plugin-sdk/setup";
import {
  buildChannelConfigSchema,
  formatWhatsAppConfigAllowFromEntries,
  getChatChannelMeta,
  normalizeE164,
  resolveWhatsAppGroupIntroHint,
  WhatsAppConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/whatsapp-core";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  type ResolvedWhatsAppAccount,
} from "./accounts.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";

export const WHATSAPP_CHANNEL = "whatsapp" as const;

export async function loadWhatsAppChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const whatsappSetupWizardProxy = createWhatsAppSetupWizardProxy(
  async () => (await loadWhatsAppChannelRuntime()).whatsappSetupWizard,
);

const whatsappConfigAdapter = createScopedChannelConfigAdapter<ResolvedWhatsAppAccount>({
  sectionKey: WHATSAPP_CHANNEL,
  listAccountIds: listWhatsAppAccountIds,
  resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultWhatsAppAccountId,
  clearBaseFields: [],
  allowTopLevel: false,
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatWhatsAppConfigAllowFromEntries(allowFrom),
  resolveDefaultTo: (account) => account.defaultTo,
});

const whatsappResolveDmPolicy = createScopedDmSecurityResolver<ResolvedWhatsAppAccount>({
  channelKey: WHATSAPP_CHANNEL,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => normalizeE164(raw),
});

export function createWhatsAppSetupWizardProxy(
  loadWizard: () => Promise<NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]>>,
): NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]> {
  return createDelegatedSetupWizardProxy({
    channel: WHATSAPP_CHANNEL,
    loadWizard,
    status: {
      configuredLabel: "linked",
      unconfiguredLabel: "not linked",
      configuredHint: "linked",
      unconfiguredHint: "not linked",
      configuredScore: 5,
      unconfiguredScore: 4,
    },
    resolveShouldPromptAccountIds: (params) =>
      (params.shouldPromptAccountIds || params.options?.promptWhatsAppAccountId) ?? false,
    credentials: [],
    delegateFinalize: true,
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
  });
}

export function createWhatsAppPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setup"]>;
  isConfigured: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["config"]>["isConfigured"];
}): Pick<
  ChannelPlugin<ResolvedWhatsAppAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "reload"
  | "gatewayMethods"
  | "configSchema"
  | "config"
  | "security"
  | "setup"
  | "groups"
> {
  return createChannelPluginBase({
    id: WHATSAPP_CHANNEL,
    meta: {
      ...getChatChannelMeta(WHATSAPP_CHANNEL),
      showConfigured: false,
      quickstartAllowFrom: true,
      forceAccountBinding: true,
      preferSessionLookupForAnnounceTarget: true,
    },
    setupWizard: params.setupWizard,
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
      ...whatsappConfigAdapter,
      isEnabled: (account, cfg) => account.enabled && cfg.web?.enabled !== false,
      disabledReason: () => "disabled",
      isConfigured: params.isConfigured,
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
    },
    security: {
      resolveDmPolicy: whatsappResolveDmPolicy,
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
    setup: params.setup,
    groups: {
      resolveRequireMention: resolveWhatsAppGroupRequireMention,
      resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
      resolveGroupIntroHint: resolveWhatsAppGroupIntroHint,
    },
  }) as Pick<
    ChannelPlugin<ResolvedWhatsAppAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "reload"
    | "gatewayMethods"
    | "configSchema"
    | "config"
    | "security"
    | "setup"
    | "groups"
  >;
}
