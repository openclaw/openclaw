import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
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
  collect(params) {
    const { channel: feishu, surface } = params;
    // Feishu account listing starts an implicit default account from top-level
    // appId+appSecret even when every named account overrides appSecret.  The
    // shared helper's isBaseFieldActiveForChannelSurface only checks whether any
    // explicit account inherits the field, so top-level appSecret refs would be
    // skipped when all accounts override.  Account for the implicit default here.
    const hasImplicitDefaultAccount =
      surface.channelEnabled &&
      hasConfiguredSecretInputValue(feishu.appId, params.defaults) &&
      hasConfiguredSecretInputValue(feishu.appSecret, params.defaults);
    if (
      hasImplicitDefaultAccount &&
      surface.hasExplicitAccounts &&
      !surface.accounts.some(
        ({ accountId }) => normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID,
      )
    ) {
      surface.accounts.push({ accountId: "default", account: {}, enabled: true });
    }
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
