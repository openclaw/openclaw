import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { createChannelPluginBase, getChatChannelMeta } from "openclaw/plugin-sdk/core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  createDelegatedSetupWizardProxy,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup-runtime";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  hasAnyWhatsAppAuth,
  type ResolvedWhatsAppAccount,
} from "./accounts.js";
import { formatWhatsAppConfigAllowFromEntries } from "./config-accessors.js";
import { WhatsAppChannelConfigSchema } from "./config-schema.js";
import { whatsappDoctor } from "./doctor.js";
import { resolveWhatsAppGroupIntroHint } from "./group-intro.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import { resolveLegacyGroupSessionKey } from "./group-session-contract.js";
import { applyWhatsAppSecurityConfigFixes } from "./security-fix.js";
import { canonicalizeLegacySessionKey, isLegacyGroupSessionKey } from "./session-contract.js";

export const WHATSAPP_CHANNEL = "whatsapp" as const;
const WHATSAPP_UNSUPPORTED_SECRET_REF_SURFACE_PATTERNS = [
  "channels.whatsapp.creds.json",
  "channels.whatsapp.accounts.*.creds.json",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectUnsupportedSecretRefConfigCandidates(raw: unknown): Array<{
  path: string;
  value: unknown;
}> {
  if (!isRecord(raw) || !isRecord(raw.channels) || !isRecord(raw.channels.whatsapp)) {
    return [];
  }

  const candidates: Array<{ path: string; value: unknown }> = [];
  const whatsapp = raw.channels.whatsapp;
  const creds = isRecord(whatsapp.creds) ? whatsapp.creds : null;
  if (creds) {
    candidates.push({
      path: "channels.whatsapp.creds.json",
      value: creds.json,
    });
  }

  const accounts = isRecord(whatsapp.accounts) ? whatsapp.accounts : null;
  if (!accounts) {
    return candidates;
  }
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!isRecord(account) || !isRecord(account.creds)) {
      continue;
    }
    candidates.push({
      path: `channels.whatsapp.accounts.${accountId}.creds.json`,
      value: account.creds.json,
    });
  }
  return candidates;
}

export async function loadWhatsAppChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const whatsappSetupWizardProxy = createWhatsAppSetupWizardProxy(
  async () => (await loadWhatsAppChannelRuntime()).whatsappSetupWizard,
);

const whatsappConfigAdapter = createScopedChannelConfigAdapter<ResolvedWhatsAppAccount>({
  sectionKey: WHATSAPP_CHANNEL,
  listAccountIds: listWhatsAppAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveWhatsAppAccount),
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
  loadWizard: () => Promise<ChannelSetupWizard>,
): ChannelSetupWizard {
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
    resolveShouldPromptAccountIds: (params) => Boolean(params.shouldPromptAccountIds),
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
      options?.onAccountId?.(WHATSAPP_CHANNEL, accountId);
    },
  });
}

export function createWhatsAppPluginBase(params: {
  groups: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["groups"]>;
  setupWizard: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setup"]>;
  isConfigured: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["config"]>["isConfigured"];
}) {
  const collectWhatsAppSecurityWarnings =
    createAllowlistProviderRouteAllowlistWarningCollector<ResolvedWhatsAppAccount>({
      providerConfigPresent: (cfg) => cfg.channels?.whatsapp !== undefined,
      resolveGroupPolicy: (account) => account.groupPolicy,
      resolveRouteAllowlistConfigured: (account) =>
        Boolean(account.groups) && Object.keys(account.groups ?? {}).length > 0,
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
    });
  const base = createChannelPluginBase({
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
    configSchema: WhatsAppChannelConfigSchema,
    config: {
      ...whatsappConfigAdapter,
      isEnabled: (account, cfg) => account.enabled && cfg.web?.enabled !== false,
      disabledReason: () => "disabled",
      isConfigured: params.isConfigured,
      hasPersistedAuthState: ({ cfg }) => hasAnyWhatsAppAuth(cfg),
      unconfiguredReason: () => "not linked",
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: Boolean(account.authDir),
          extra: {
            linked: Boolean(account.authDir),
            dmPolicy: account.dmPolicy,
            allowFrom: account.allowFrom,
          },
        }),
    },
    security: {
      applyConfigFixes: applyWhatsAppSecurityConfigFixes,
      resolveDmPolicy: whatsappResolveDmPolicy,
      collectWarnings: collectWhatsAppSecurityWarnings,
    },
    doctor: whatsappDoctor,
    setup: params.setup,
    groups: params.groups,
  });
  return {
    ...base,
    setupWizard: base.setupWizard!,
    capabilities: base.capabilities!,
    reload: base.reload!,
    gatewayMethods: base.gatewayMethods!,
    configSchema: base.configSchema!,
    config: base.config!,
    messaging: {
      defaultMarkdownTableMode: "bullets",
      resolveLegacyGroupSessionKey,
      isLegacyGroupSessionKey,
      canonicalizeLegacySessionKey: (params) =>
        canonicalizeLegacySessionKey({ key: params.key, agentId: params.agentId }),
    },
    secrets: {
      unsupportedSecretRefSurfacePatterns: WHATSAPP_UNSUPPORTED_SECRET_REF_SURFACE_PATTERNS,
      collectUnsupportedSecretRefConfigCandidates,
    },
    security: base.security!,
    groups: base.groups!,
  } satisfies Pick<
    ChannelPlugin<ResolvedWhatsAppAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "reload"
    | "gatewayMethods"
    | "configSchema"
    | "config"
    | "messaging"
    | "secrets"
    | "security"
    | "doctor"
    | "setup"
    | "groups"
  >;
}
