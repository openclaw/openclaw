import {
  collectConditionalChannelFieldAssignments,
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  createChannelSecretContract,
  hasOwnProperty,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createChannelSecretContract({
  channelKey: "slack",
  account: ["appToken", "relay.authToken", "botToken", "signingSecret", "userToken"],
  channel: ["appToken", "botToken", "relay.authToken", "signingSecret", "userToken"],
  collect(params) {
    const { channel: slack, surface } = params;
    const resolveMode = (value: unknown) =>
      value === "http" || value === "socket" || value === "relay" ? value : undefined;
    const baseMode = resolveMode(slack.mode) ?? "socket";
    const fields = ["botToken", "userToken"] as const;
    for (const field of fields) {
      collectSimpleChannelFieldAssignments({
        ...params,
        field,
        topInactiveReason: `no enabled account inherits this top-level Slack ${field}.`,
        accountInactiveReason: "Slack account is disabled.",
      });
    }
    const resolveAccountMode = (account: Record<string, unknown>) =>
      resolveMode(account.mode) ?? baseMode;
    const hasNestedAuthTokenOverride = (account: Record<string, unknown>) => {
      const relay = account.relay;
      return (
        relay !== null &&
        typeof relay === "object" &&
        !Array.isArray(relay) &&
        hasOwnProperty(relay as Record<string, unknown>, "authToken")
      );
    };
    for (const [field, mode, label] of [
      ["appToken", "socket", "socket"],
      ["signingSecret", "http", "HTTP"],
    ] as const) {
      collectConditionalChannelFieldAssignments({
        ...params,
        field,
        topLevelActiveWithoutAccounts: baseMode === mode,
        topLevelInheritedAccountActive: ({ account, enabled }) =>
          enabled && !hasOwnProperty(account, field) && resolveAccountMode(account) === mode,
        accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === mode,
        topInactiveReason: `no enabled Slack ${label}-mode surface inherits this top-level ${field}.`,
        accountInactiveReason: `Slack account is disabled or not running in ${label} mode.`,
      });
    }
    collectNestedChannelFieldAssignments({
      ...params,
      nestedKey: "relay",
      field: "authToken",
      topLevelActive:
        surface.channelEnabled &&
        ((!surface.hasExplicitAccounts && baseMode === "relay") ||
          surface.accounts.some(
            ({ account, enabled }) =>
              enabled &&
              resolveAccountMode(account) === "relay" &&
              !hasNestedAuthTokenOverride(account),
          )),
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled && resolveAccountMode(account) === "relay" && !hasNestedAuthTokenOverride(account),
      topInactiveReason:
        "no enabled Slack relay-mode surface inherits this top-level relay authToken.",
      accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "relay",
      accountInactiveReason: "Slack account is disabled or not running in relay mode.",
    });
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
