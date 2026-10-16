import {
  createChannelSecretContract,
  hasOwnProperty,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/setup";

export const channelSecrets = createChannelSecretContract({
  channelKey: "msteams",
  account: ["appPassword"],
  channel: ["appPassword"],
  collect(params) {
    const { channel: msteams, surface } = params;

    params.collectSecret(msteams, "appPassword", "channels.msteams.appPassword", {
      active: isRootDefaultIdentityActive(msteams, surface),
      inactiveReason: "no enabled account inherits this top-level Microsoft Teams appPassword.",
      owner: {
        ownerKind: "account",
        ownerId: "msteams:default",
        requiredForGateway: false,
        disposition: "isolate",
        contract: msteams,
      },
    });

    if (!surface.hasExplicitAccounts) {
      return;
    }
    for (const { accountId, account, enabled } of surface.accounts) {
      if (!hasOwnProperty(account, "appPassword")) {
        continue;
      }
      params.collectSecret(
        account,
        "appPassword",
        `channels.msteams.accounts.${accountId}.appPassword`,
        {
          active: enabled,
          inactiveReason: "Microsoft Teams account is disabled.",
          owner: {
            ownerKind: "account",
            ownerId: `msteams:${normalizeAccountId(accountId)}`,
            requiredForGateway: false,
            disposition: "isolate",
            contract: account,
          },
        },
      );
    }
  },
});

function isConfiguredIdentityField(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

function isRootDefaultIdentityActive(
  channel: Record<string, unknown>,
  surface: {
    channelEnabled: boolean;
    hasExplicitAccounts: boolean;
    accounts: readonly { accountId: string; enabled: boolean }[];
  },
): boolean {
  const explicitDefault = surface.hasExplicitAccounts
    ? surface.accounts.find(({ accountId }) => normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID)
    : undefined;
  const defaultEnabled = explicitDefault?.enabled ?? surface.channelEnabled;
  return (
    defaultEnabled &&
    (isConfiguredIdentityField(channel.appId) || isConfiguredIdentityField(channel.appPassword))
  );
}

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
