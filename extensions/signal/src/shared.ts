// Signal plugin module implements shared behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createChannelPluginBase, getChatChannelMeta } from "openclaw/plugin-sdk/core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { normalizeStringifiedEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  type ResolvedSignalAccount,
} from "./accounts.js";
import { SignalChannelConfigSchema } from "./config-schema.js";
import { createSignalSetupWizardProxy } from "./setup-core.js";

const SIGNAL_CHANNEL = "signal" as const;
const INHERITED_NOTE_TO_SELF_FIELDS = [
  "account",
  "accountUuid",
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "cliPath",
  "ingressMode",
] as const;

type SignalConfigSection = {
  account?: string;
  accountUuid?: string;
  configPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: number;
  cliPath?: string;
  ingressMode?: string;
  accounts?: Record<string, Record<string, unknown> | undefined>;
};

async function loadSignalChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const signalSetupWizard = createSignalSetupWizardProxy(
  async () => (await loadSignalChannelRuntime()).signalSetupWizard,
);

const baseSignalConfigAdapter = createScopedChannelConfigAdapter<ResolvedSignalAccount>({
  sectionKey: SIGNAL_CHANNEL,
  listAccountIds: (cfg) => listSignalAccountIds(cfg),
  resolveAccount: adaptScopedAccountAccessor((params) => resolveSignalAccount(params)),
  defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
  clearBaseFields: [
    "account",
    "accountUuid",
    "configPath",
    "httpUrl",
    "httpHost",
    "httpPort",
    "cliPath",
    "ingressMode",
    "name",
  ],
  resolveAllowFrom: (account: ResolvedSignalAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    normalizeStringifiedEntries(allowFrom)
      .map((entry) => (entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))))
      .filter(Boolean),
  resolveDefaultTo: (account: ResolvedSignalAccount) => account.config.defaultTo,
});

function materializeInheritedNoteToSelfAccounts(params: {
  cfg: OpenClawConfig;
  updated: OpenClawConfig;
}): OpenClawConfig {
  const originalSignal = params.cfg.channels?.signal as SignalConfigSection | undefined;
  const rootAccount = originalSignal?.account?.trim();
  if (!rootAccount) {
    return params.updated;
  }
  const updatedSignal = params.updated.channels?.signal as SignalConfigSection | undefined;
  const accounts = updatedSignal?.accounts;
  if (!updatedSignal || !accounts) {
    return params.updated;
  }
  let changed = false;
  const nextAccounts = Object.fromEntries(
    Object.entries(accounts).map(([accountId, account]) => {
      const entry = account ?? {};
      const inheritedNoteToSelf =
        (entry.ingressMode ?? originalSignal?.ingressMode) === "note-to-self";
      if (inheritedNoteToSelf) {
        const materialized: Record<string, unknown> = { ...entry };
        if (!materialized.account) {
          materialized.account = rootAccount;
        }
        for (const field of INHERITED_NOTE_TO_SELF_FIELDS) {
          if (field in materialized) {
            continue;
          }
          if (
            field === "accountUuid" &&
            normalizeE164(String(materialized.account ?? "")) !== normalizeE164(rootAccount)
          ) {
            continue;
          }
          const value = originalSignal?.[field];
          if (value !== undefined) {
            materialized[field] = value;
          }
        }
        const hasChanged = INHERITED_NOTE_TO_SELF_FIELDS.some(
          (field) => materialized[field] !== entry[field],
        );
        changed ||= hasChanged;
        return [accountId, hasChanged ? materialized : entry];
      }
      return [accountId, entry];
    }),
  );
  if (!changed) {
    return params.updated;
  }
  return {
    ...params.updated,
    channels: {
      ...params.updated.channels,
      signal: {
        ...updatedSignal,
        accounts: nextAccounts,
      },
    },
  } as OpenClawConfig;
}

export const signalConfigAdapter = {
  ...baseSignalConfigAdapter,
  deleteAccount(params: { cfg: OpenClawConfig; accountId: string }): OpenClawConfig {
    const updated = baseSignalConfigAdapter.deleteAccount?.(params) ?? params.cfg;
    return params.accountId === "default"
      ? materializeInheritedNoteToSelfAccounts({ cfg: params.cfg, updated })
      : updated;
  },
};

export const signalSecurityAdapter = createRestrictSendersChannelSecurity<ResolvedSignalAccount>({
  channelKey: SIGNAL_CHANNEL,
  resolveDmPolicy: (account) => account.config.dmPolicy,
  resolveDmAllowFrom: (account) => account.config.allowFrom,
  resolveGroupPolicy: (account) => account.config.groupPolicy,
  surface: "Signal groups",
  openScope: "any member",
  groupPolicyPath: "channels.signal.groupPolicy",
  groupAllowFromPath: "channels.signal.groupAllowFrom",
  mentionGated: false,
  policyPathSuffix: "dmPolicy",
  normalizeDmEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim()),
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
  | "messaging"
> {
  const base = createChannelPluginBase({
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
    configSchema: SignalChannelConfigSchema,
    config: {
      ...signalConfigAdapter,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            baseUrl: account.baseUrl,
          },
        }),
    },
    security: signalSecurityAdapter,
    setup: params.setup,
  });
  return {
    ...base,
    messaging: {
      defaultMarkdownTableMode: "bullets",
    },
  } as Pick<
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
    | "messaging"
  >;
}
