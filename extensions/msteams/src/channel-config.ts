import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createHybridChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createAllowlistProviderGroupPolicyWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "../runtime-api.js";
import { DEFAULT_ACCOUNT_ID } from "../runtime-api.js";
import { patchMSTeamsAccountConfig } from "./accounts-mutations.js";
import {
  inspectMSTeamsAccount,
  listMSTeamsAccountIds,
  resolveDefaultMSTeamsAccountId,
  resolveMSTeamsAccount,
  resolveMSTeamsAccountConfig,
  resolveMSTeamsAccountEntryKey,
  type ResolvedMSTeamsAccount,
} from "./accounts.js";

export type { ResolvedMSTeamsAccount } from "./accounts.js";

export const msteamsMeta = {
  id: "msteams",
  label: "Microsoft Teams",
  selectionLabel: "Microsoft Teams (Bot Framework)",
  docsPath: "/channels/msteams",
  docsLabel: "msteams",
  blurb: "Teams SDK; enterprise support.",
  aliases: ["teams"],
  order: 60,
} as const;

function resolveMSTeamsSecurityWarningAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMSTeamsAccountId(params.cfg),
  );
  return {
    accountId,
    config: resolveMSTeamsAccountConfig(params.cfg, accountId),
  };
}

export const collectMSTeamsSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
  cfg: OpenClawConfig;
  accountId?: string | null;
}>({
  providerConfigPresent: (cfg) => cfg.channels?.msteams !== undefined,
  resolveGroupPolicy: (params) => resolveMSTeamsSecurityWarningAccount(params).config.groupPolicy,
  collect: ({ cfg, accountId, groupPolicy }) => {
    if (groupPolicy !== "open") {
      return [];
    }
    const account = resolveMSTeamsSecurityWarningAccount({ cfg, accountId });
    const accounts = cfg.channels?.msteams?.accounts;
    const rawAccountKey = accounts
      ? Object.keys(accounts).find((key) => normalizeAccountId(key) === account.accountId)
      : undefined;
    const hasAccountPolicyOverride =
      rawAccountKey !== undefined && accounts?.[rawAccountKey]?.groupPolicy !== undefined;
    const configPath =
      account.accountId === DEFAULT_ACCOUNT_ID && !hasAccountPolicyOverride
        ? "channels.msteams"
        : `channels.msteams.accounts.${rawAccountKey ?? account.accountId}`;
    const surface =
      configPath === "channels.msteams" ? "MS Teams" : `MS Teams[${account.accountId}]`;
    return [
      `- ${surface} groups: groupPolicy="open" allows any member to trigger (mention-gated). Set ${configPath}.groupPolicy="allowlist" + ${configPath}.groupAllowFrom to restrict senders.`,
    ];
  },
});

function deleteMSTeamsDefaultAccountIdentity(cfg: OpenClawConfig): OpenClawConfig {
  const msteams = cfg.channels?.msteams ?? {};
  const { appId: _appId, appPassword: _appPassword, accounts, defaultAccount, ...rest } = msteams;
  const defaultKey =
    resolveMSTeamsAccountEntryKey(accounts, DEFAULT_ACCOUNT_ID) ?? DEFAULT_ACCOUNT_ID;
  // A tombstone prevents environment credentials from reviving the deleted bot on reload.
  const nextAccounts = { ...accounts, [defaultKey]: { enabled: false } };
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...rest,
        ...(defaultAccount && normalizeAccountId(defaultAccount) !== DEFAULT_ACCOUNT_ID
          ? { defaultAccount }
          : {}),
        accounts: nextAccounts,
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

function deleteExplicitMSTeamsAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): OpenClawConfig | undefined {
  const channel = params.cfg.channels?.msteams;
  const accounts = channel?.accounts;
  const rawKey = resolveMSTeamsAccountEntryKey(accounts, normalizeAccountId(params.accountId));
  if (!channel || !accounts || !rawKey) {
    return undefined;
  }
  const nextAccounts = { ...accounts };
  delete nextAccounts[rawKey];
  const deletedDefault = normalizeAccountId(channel.defaultAccount) === normalizeAccountId(rawKey);
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      msteams: {
        ...channel,
        accounts: Object.keys(nextAccounts).length > 0 ? nextAccounts : undefined,
        defaultAccount: deletedDefault ? undefined : channel.defaultAccount,
      },
    },
  };
}

export const msteamsConfigAdapter = {
  ...msteamsBaseConfigAdapter,
  setAccountEnabled: (params: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) =>
    patchMSTeamsAccountConfig({
      cfg: params.cfg,
      accountId: params.accountId,
      patch: { enabled: params.enabled },
      ensureEnabled:
        params.enabled &&
        params.cfg.channels?.msteams?.enabled === false &&
        listMSTeamsAccountIds(params.cfg).length === 1,
      scopeDefaultToAccounts: true,
    }),
  deleteAccount: (params: { cfg: OpenClawConfig; accountId: string }) =>
    normalizeAccountId(params.accountId) === DEFAULT_ACCOUNT_ID
      ? deleteMSTeamsDefaultAccountIdentity(params.cfg)
      : (deleteExplicitMSTeamsAccount({
          cfg: params.cfg,
          accountId: params.accountId,
        }) ?? msteamsBaseConfigAdapter.deleteAccount!(params)),
};
