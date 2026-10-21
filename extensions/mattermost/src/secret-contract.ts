import {
  collectSimpleChannelFieldAssignments,
  createChannelSecretContract,
  hasConfiguredSecretInputValue,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const channelSecrets = createChannelSecretContract({
  channelKey: "mattermost",
  account: ["botToken"],
  channel: ["botToken"],
  hasImplicitDefaultAccount: ({ channel, context, defaults }) =>
    Boolean(normalizeOptionalString(channel.baseUrl)) &&
    (hasConfiguredSecretInputValue(channel.botToken, defaults) ||
      Boolean(normalizeOptionalString(context.env.MATTERMOST_BOT_TOKEN))),
  collect(params) {
    collectSimpleChannelFieldAssignments({
      ...params,
      field: "botToken",
      topInactiveReason: "no enabled account inherits this top-level Mattermost botToken.",
      accountInactiveReason: "Mattermost account is disabled.",
    });
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
