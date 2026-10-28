import { hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-helpers";
import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretContract,
  hasOwnProperty,
  normalizeSecretStringValue,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createChannelSecretContract({
  channelKey: "zalo",
  account: ["botToken", "webhookSecret"],
  channel: ["botToken", "webhookSecret"],
  // Match the credential sources used for the implicit default in account listing.
  hasImplicitDefaultAccount: ({ channel, context }) =>
    [channel.botToken, channel.tokenFile, context.env.ZALO_BOT_TOKEN].some(
      hasConfiguredAccountValue,
    ),
  collect(params) {
    const { channel: zalo } = params;
    collectConditionalChannelFieldAssignments({
      ...params,
      field: "botToken",
      topLevelActiveWithoutAccounts: true,
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled &&
        !hasOwnProperty(account, "botToken") &&
        !normalizeSecretStringValue(account.tokenFile),
      accountActive: ({ enabled }) => enabled,
      topInactiveReason: "no enabled Zalo surface inherits this top-level botToken.",
      accountInactiveReason: "Zalo account is disabled.",
    });
    const baseWebhookUrl = normalizeSecretStringValue(zalo.webhookUrl);
    const accountWebhookUrl = (account: Record<string, unknown>) =>
      hasOwnProperty(account, "webhookUrl")
        ? normalizeSecretStringValue(account.webhookUrl)
        : baseWebhookUrl;
    collectConditionalChannelFieldAssignments({
      ...params,
      field: "webhookSecret",
      topLevelActiveWithoutAccounts: baseWebhookUrl.length > 0,
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled &&
        !hasOwnProperty(account, "webhookSecret") &&
        accountWebhookUrl(account).length > 0,
      accountActive: ({ account, enabled }) => enabled && accountWebhookUrl(account).length > 0,
      topInactiveReason:
        "no enabled Zalo webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
      accountInactiveReason:
        "Zalo account is disabled or webhook mode is not active for this account.",
    });
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
