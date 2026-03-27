import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { createChannelPluginBase } from "openclaw/plugin-sdk/core";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  type ResolvedSignalAccount,
} from "./accounts.js";
import { SignalChannelConfigSchema } from "./config-schema.js";
import { getChatChannelMeta, normalizeE164, type ChannelPlugin } from "./runtime-api.js";
import { createSignalSetupWizardProxy } from "./setup-core.js";

export const SIGNAL_CHANNEL = "signal" as const;

async function loadSignalChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const signalSetupWizard = createSignalSetupWizardProxy(
  async () => (await loadSignalChannelRuntime()).signalSetupWizard,
);

export const signalConfigAdapter = createScopedChannelConfigAdapter<ResolvedSignalAccount>({
  sectionKey: SIGNAL_CHANNEL,
  listAccountIds: listSignalAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveSignalAccount),
  defaultAccountId: resolveDefaultSignalAccountId,
  clearBaseFields: ["account", "httpUrl", "httpHost", "httpPort", "cliPath", "name"],
  resolveAllowFrom: (account: ResolvedSignalAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => (entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))))
      .filter(Boolean),
  resolveDefaultTo: (account: ResolvedSignalAccount) => account.config.defaultTo,
});

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
