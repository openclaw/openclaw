// Msteams plugin module implements channel.setup behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createHybridChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import {
  inspectMSTeamsAccount,
  listMSTeamsAccountIds,
  resolveDefaultMSTeamsAccountId,
  resolveMSTeamsAccount,
  resolveMSTeamsAccountConfig,
  type ResolvedMSTeamsAccount,
} from "./accounts.js";
import { MSTeamsChannelConfigSchema } from "./config-schema.js";
import { msteamsSetupAdapter } from "./setup-core.js";
import { msteamsSetupWizard } from "./setup-surface.js";

const meta = {
  id: "msteams",
  label: "Microsoft Teams",
  selectionLabel: "Microsoft Teams (Bot Framework)",
  docsPath: "/channels/msteams",
  docsLabel: "msteams",
  blurb: "Teams SDK; enterprise support.",
  aliases: ["teams"],
  order: 60,
} as const;

function deleteMSTeamsDefaultAccountIdentity(cfg: OpenClawConfig): OpenClawConfig {
  const msteams = cfg.channels?.msteams;
  if (!msteams) {
    return cfg;
  }
  const {
    appId: _appId,
    appPassword: _appPassword,
    accounts,
    defaultAccount,
    webhook,
    ...rest
  } = msteams;
  const nextAccounts = accounts ? { ...accounts } : undefined;
  if (nextAccounts) {
    delete nextAccounts[DEFAULT_ACCOUNT_ID];
  }
  const nextWebhook = webhook ? { ...webhook } : undefined;
  if (nextWebhook) {
    delete nextWebhook.port;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...rest,
        ...(defaultAccount && defaultAccount !== DEFAULT_ACCOUNT_ID ? { defaultAccount } : {}),
        ...(nextAccounts && Object.keys(nextAccounts).length > 0 ? { accounts: nextAccounts } : {}),
        ...(nextWebhook && Object.keys(nextWebhook).length > 0 ? { webhook: nextWebhook } : {}),
      },
    },
  };
}

const msteamsBaseConfigAdapter = createHybridChannelConfigAdapter<
  ResolvedMSTeamsAccount,
  ReturnType<typeof resolveMSTeamsAccountConfig>
>({
  sectionKey: "msteams",
  listAccountIds: listMSTeamsAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveMSTeamsAccount),
  resolveAccessorAccount: ({ cfg, accountId }) => resolveMSTeamsAccountConfig(cfg, accountId),
  inspectAccount: adaptScopedAccountAccessor(inspectMSTeamsAccount),
  defaultAccountId: resolveDefaultMSTeamsAccountId,
  clearBaseFields: ["appId", "appPassword"],
  preserveSectionOnDefaultDelete: true,
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.defaultTo,
});

const msteamsConfigAdapter = {
  ...msteamsBaseConfigAdapter,
  deleteAccount: (params: { cfg: OpenClawConfig; accountId: string }) =>
    params.accountId === DEFAULT_ACCOUNT_ID
      ? deleteMSTeamsDefaultAccountIdentity(params.cfg)
      : msteamsBaseConfigAdapter.deleteAccount!(params),
};

export const msteamsSetupPlugin: ChannelPlugin<ResolvedMSTeamsAccount> = {
  id: "msteams",
  meta: {
    ...meta,
    aliases: [...meta.aliases],
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.msteams"] },
  configSchema: MSTeamsChannelConfigSchema,
  config: {
    ...msteamsConfigAdapter,
    isConfigured: (account) => account.configured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
      }),
  },
  setupWizard: msteamsSetupWizard,
  setup: msteamsSetupAdapter,
};
