import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";
import { resolveMSTeamsAccountEntryKey } from "./accounts.js";
import { hasConfiguredMSTeamsCredentials } from "./token-config.js";

type MSTeamsSetupAccountConfig = NonNullable<MSTeamsConfig["accounts"]>[string];

function splitRootIdentity(msteams: MSTeamsConfig): {
  root: MSTeamsConfig;
  defaultAccount: MSTeamsSetupAccountConfig;
} {
  const { appId, appPassword, ...root } = msteams;
  return {
    root,
    defaultAccount: {
      ...(msteams.enabled === false &&
      (appId !== undefined || appPassword !== undefined || hasConfiguredMSTeamsCredentials(msteams))
        ? { enabled: false }
        : {}),
      ...(appId !== undefined ? { appId } : {}),
      ...(appPassword !== undefined ? { appPassword } : {}),
    },
  };
}

export function patchMSTeamsAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: MSTeamsSetupAccountConfig;
  ensureEnabled?: boolean;
  scopeDefaultToAccounts?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const msteams = params.cfg.channels?.msteams ?? {};
  const ensureEnabled = params.ensureEnabled ?? true;
  const scopeDefaultToAccounts =
    params.scopeDefaultToAccounts ??
    (accountId === DEFAULT_ACCOUNT_ID && Object.keys(msteams.accounts ?? {}).length > 0);
  if (accountId === DEFAULT_ACCOUNT_ID && !scopeDefaultToAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        msteams: {
          ...msteams,
          ...(ensureEnabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const { root: baseMsteams, defaultAccount } = splitRootIdentity(msteams);
  // Opening the channel gate must not re-enable accounts the old gate kept disabled.
  const baseAccounts =
    ensureEnabled && msteams.enabled === false
      ? Object.fromEntries(
          Object.entries(baseMsteams.accounts ?? {}).map(([key, account]) => [
            key,
            { ...account, enabled: false },
          ]),
        )
      : (baseMsteams.accounts ?? {});
  const hasPromotedDefaultIdentity = Object.keys(defaultAccount).length > 0;
  const promotedDefaultKey =
    resolveMSTeamsAccountEntryKey(baseAccounts, DEFAULT_ACCOUNT_ID) ?? DEFAULT_ACCOUNT_ID;
  const accounts =
    hasPromotedDefaultIdentity && accountId !== DEFAULT_ACCOUNT_ID
      ? {
          ...baseAccounts,
          [promotedDefaultKey]: {
            ...defaultAccount,
            ...baseAccounts[promotedDefaultKey],
          },
        }
      : baseAccounts;
  // Preserve the authored key when an existing account normalizes to this ID.
  const rawAccountKey = resolveMSTeamsAccountEntryKey(accounts, accountId) ?? accountId;
  const existing =
    accountId === DEFAULT_ACCOUNT_ID
      ? { ...defaultAccount, ...accounts[rawAccountKey] }
      : (accounts[rawAccountKey] ?? {});
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      msteams: {
        ...baseMsteams,
        ...(ensureEnabled ? { enabled: true } : {}),
        accounts: {
          ...accounts,
          [rawAccountKey]: {
            ...existing,
            ...(ensureEnabled ? { enabled: true } : {}),
            ...params.patch,
          },
        },
      },
    },
  };
}
