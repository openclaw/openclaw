import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretContract,
  hasConfiguredSecretInputValue,
  hasOwnProperty,
  normalizeSecretStringValue,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createChannelSecretContract({
  channelKey: "feishu",
  account: ["appSecret", "encryptKey", "verificationToken"],
  channel: ["appSecret", "encryptKey", "verificationToken"],
  hasImplicitDefaultAccount: ({ channel, defaults }) =>
    hasConfiguredSecretInputValue(channel.appId, defaults) &&
    hasConfiguredSecretInputValue(channel.appSecret, defaults),
  collect(params) {
    const { channel: feishu, surface } = params;
    collectConditionalChannelFieldAssignments({
      ...params,
      field: "appSecret",
      topLevelActiveWithoutAccounts: surface.channelEnabled,
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled && !hasOwnProperty(account, "appSecret"),
      accountActive: ({ enabled }) => enabled,
      topInactiveReason: "no enabled account inherits this top-level Feishu appSecret.",
      accountInactiveReason: "Feishu account is disabled.",
    });
    const baseConnectionMode =
      normalizeSecretStringValue(feishu.connectionMode) === "webhook" ? "webhook" : "websocket";
    const resolveAccountMode = (account: Record<string, unknown>) =>
      hasOwnProperty(account, "connectionMode")
        ? normalizeSecretStringValue(account.connectionMode)
        : baseConnectionMode;
    for (const field of ["encryptKey", "verificationToken"] as const) {
      collectConditionalChannelFieldAssignments({
        ...params,
        field,
        topLevelActiveWithoutAccounts: baseConnectionMode === "webhook",
        topLevelInheritedAccountActive: ({ account, enabled }) =>
          enabled && !hasOwnProperty(account, field) && resolveAccountMode(account) === "webhook",
        accountActive: ({ account, enabled }) =>
          enabled && resolveAccountMode(account) === "webhook",
        topInactiveReason: `no enabled Feishu webhook-mode surface inherits this top-level ${field}.`,
        accountInactiveReason: "Feishu account is disabled or not running in webhook mode.",
      });
    }
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
