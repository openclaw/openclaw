import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretContract,
  hasConfiguredSecretInputValue,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const channelSecrets = createChannelSecretContract({
  channelKey: "clickclack",
  account: ["token"],
  channel: ["token"],
  collect(params) {
    const { channel: clickclack } = params;
    const baseTokenFile = normalizeOptionalString(clickclack.tokenFile) ?? "";
    const accountTokenFile = (account: Record<string, unknown>) =>
      normalizeOptionalString(account.tokenFile) ?? "";
    const hasImplicitDefault =
      Boolean(normalizeOptionalString(clickclack.baseUrl)) &&
      Boolean(normalizeOptionalString(clickclack.workspace));

    collectConditionalChannelFieldAssignments({
      ...params,
      field: "token",
      topLevelActiveWithoutAccounts: baseTokenFile.length === 0,
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        (hasImplicitDefault && baseTokenFile.length === 0) ||
        (enabled &&
          baseTokenFile.length === 0 &&
          accountTokenFile(account).length === 0 &&
          !hasConfiguredSecretInputValue(account.token, params.defaults)),
      accountActive: ({ account, enabled }) => enabled && accountTokenFile(account).length === 0,
      topInactiveReason:
        "no enabled ClickClack account inherits this top-level token (tokenFile is configured).",
      accountInactiveReason: "ClickClack account is disabled or tokenFile is configured.",
    });
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
