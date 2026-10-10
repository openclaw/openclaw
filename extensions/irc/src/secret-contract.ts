import {
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  createChannelSecretContract,
  isBaseFieldActiveForChannelSurface,
  isEnabledFlag,
  isRecord,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

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
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled && !Object.hasOwn(account, "nickserv") && isEnabledFlag(irc.nickserv),
      topInactiveReason:
        "no enabled account inherits this top-level IRC nickserv config or NickServ is disabled.",
      accountActive: ({ account, enabled }) =>
        enabled && isRecord(account.nickserv) && isEnabledFlag(account.nickserv),
      accountInactiveReason: "IRC account is disabled or NickServ is disabled for this account.",
    });
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
