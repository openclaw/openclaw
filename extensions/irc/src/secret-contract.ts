import {
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  createChannelSecretContract,
  isBaseFieldActiveForChannelSurface,
  isEnabledFlag,
  isRecord,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

// Account resolution merges `nickserv` field by field, so an account inherits every top-level
// NickServ leaf it does not set itself. The activation predicates must follow that merge instead
// of the presence of the whole `nickserv` block.
function accountNickServ(account: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(account.nickserv) ? account.nickserv : undefined;
}

// `enabled` is merged the same way, so both top-level and account-owned references follow the
// flag the account actually runs with.
function mergedNickServEnabled(channel: unknown, account: unknown): boolean {
  return isEnabledFlag({
    ...(isRecord(channel) ? channel : {}),
    ...(isRecord(account) ? account : {}),
  });
}

export const channelSecrets = createChannelSecretContract({
  channelKey: "irc",
  account: ["nickserv.password", "password"],
  channel: ["nickserv.password", "password"],
  collect(params) {
    const { channel: irc, surface } = params;
    collectSimpleChannelFieldAssignments({
      ...params,
      field: "password",
      topInactiveReason: "no enabled account inherits this top-level IRC password.",
      accountInactiveReason: "IRC account is disabled.",
    });
    collectNestedChannelFieldAssignments({
      ...params,
      nestedKey: "nickserv",
      field: "password",
      topLevelActive:
        isBaseFieldActiveForChannelSurface(surface, "nickserv") &&
        isRecord(irc.nickserv) &&
        isEnabledFlag(irc.nickserv),
      topLevelInheritedAccountActive: ({ account, enabled }) => {
        const accountConfig = accountNickServ(account);
        return (
          enabled &&
          !Object.hasOwn(accountConfig ?? {}, "password") &&
          mergedNickServEnabled(irc.nickserv, accountConfig)
        );
      },
      topInactiveReason:
        "no enabled account inherits this top-level IRC nickserv config or NickServ is disabled.",
      accountActive: ({ account, enabled }) => {
        const accountConfig = accountNickServ(account);
        return (
          enabled && Boolean(accountConfig) && mergedNickServEnabled(irc.nickserv, accountConfig)
        );
      },
      accountInactiveReason: "IRC account is disabled or NickServ is disabled for this account.",
    });
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
