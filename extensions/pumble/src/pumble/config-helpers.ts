import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk";

/**
 * Apply Pumble credentials to the config at the correct location
 * (top-level for default account, nested for named accounts).
 */
export function applyPumbleCredentials(params: {
  cfg: OpenClawConfig;
  accountId: string;
  creds: {
    appId?: string;
    appKey?: string;
    botToken?: string;
    clientSecret?: string;
    signingSecret?: string;
  };
  name?: string;
}): OpenClawConfig {
  const { cfg, accountId, creds } = params;

  let next = applyAccountNameToChannelSection({
    cfg,
    channelKey: "pumble",
    accountId,
    name: params.name,
  });

  if (accountId !== DEFAULT_ACCOUNT_ID) {
    next = migrateBaseNameToDefaultAccount({
      cfg: next,
      channelKey: "pumble",
    });
  }

  const credFields = {
    ...(creds.appId ? { appId: creds.appId } : {}),
    ...(creds.appKey ? { appKey: creds.appKey } : {}),
    ...(creds.botToken ? { botToken: creds.botToken } : {}),
    ...(creds.clientSecret ? { clientSecret: creds.clientSecret } : {}),
    ...(creds.signingSecret ? { signingSecret: creds.signingSecret } : {}),
  };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...next,
      channels: {
        ...next.channels,
        pumble: {
          ...next.channels?.pumble,
          enabled: true,
          ...credFields,
        },
      },
    };
  }

  return {
    ...next,
    channels: {
      ...next.channels,
      pumble: {
        ...next.channels?.pumble,
        enabled: true,
        accounts: {
          ...next.channels?.pumble?.accounts,
          [accountId]: {
            ...next.channels?.pumble?.accounts?.[accountId],
            enabled: true,
            ...credFields,
          },
        },
      },
    },
  };
}
