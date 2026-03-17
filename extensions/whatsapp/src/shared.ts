import {
  buildAccountScopedDmSecurityPolicy,
  collectAllowlistProviderGroupPolicyWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
} from "openclaw/plugin-sdk/compat";
import { buildChannelConfigSchema } from "../../../src/channels/plugins/config-schema.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "../../../src/channels/plugins/group-mentions.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.plugin.js";
import { resolveWhatsAppGroupIntroHint } from "../../../src/channels/plugins/whatsapp-shared.js";
import { getChatChannelMeta } from "../../../src/channels/registry.js";
import { WhatsAppConfigSchema } from "../../../src/config/zod-schema.providers-whatsapp.js";
import {
  formatWhatsAppConfigAllowFromEntries,
  resolveWhatsAppConfigAllowFrom,
  resolveWhatsAppConfigDefaultTo,
} from "../../../src/plugin-sdk/channel-config-helpers.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { normalizeE164 } from "../../../src/utils.js";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  type ResolvedWhatsAppAccount,
} from "./accounts.js";

export const WHATSAPP_CHANNEL = "whatsapp" as const;

export async function loadWhatsAppChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const whatsappSetupWizardProxy = createWhatsAppSetupWizardProxy(async () => ({
  whatsappSetupWizard: (await loadWhatsAppChannelRuntime()).whatsappSetupWizard,
}));

export function createWhatsAppSetupWizardProxy(
  loadWizard: () => Promise<{
    whatsappSetupWizard: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]>;
  }>,
): NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]> {
  return {
    channel: WHATSAPP_CHANNEL,
    status: {
      configuredLabel: "linked",
      unconfiguredLabel: "not linked",
      configuredHint: "linked",
      unconfiguredHint: "not linked",
      configuredScore: 5,
      unconfiguredScore: 4,
      resolveConfigured: async ({ cfg }) =>
        await (await loadWizard()).whatsappSetupWizard.status.resolveConfigured({ cfg }),
      resolveStatusLines: async ({ cfg, configured }) =>
        (await (
          await loadWizard()
        ).whatsappSetupWizard.status.resolveStatusLines?.({
          cfg,
          configured,
        })) ?? [],
    },
    resolveShouldPromptAccountIds: (params) =>
      (params.shouldPromptAccountIds || params.options?.promptWhatsAppAccountId) ?? false,
    credentials: [],
    finalize: async (params) => await (await loadWizard()).whatsappSetupWizard.finalize!(params),
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
  };
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
  return {
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
      resolveAllowFrom: ({ cfg, accountId }) => resolveWhatsAppConfigAllowFrom({ cfg, accountId }),
      formatAllowFrom: ({ allowFrom }) => formatWhatsAppConfigAllowFromEntries(allowFrom),
      resolveDefaultTo: ({ cfg, accountId }) => resolveWhatsAppConfigDefaultTo({ cfg, accountId }),
    },
    security: {
      resolveDmPolicy: ({ cfg, accountId, account }) =>
        buildAccountScopedDmSecurityPolicy({
          cfg,
          channelKey: WHATSAPP_CHANNEL,
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
    setup: params.setup,
    groups: {
      resolveRequireMention: resolveWhatsAppGroupRequireMention,
      resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
      resolveGroupIntroHint: resolveWhatsAppGroupIntroHint,
    },
  };
}
