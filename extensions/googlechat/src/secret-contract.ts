// Secret-target discovery must not load provider setup or resolution runtimes.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretContract,
  hasOwnProperty,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createChannelSecretContract({
  channelKey: "googlechat",
  account: [
    {
      path: "serviceAccount",
      targetType: "channels.googlechat.serviceAccount",
      targetTypeAliases: ["channels.googlechat.accounts.*.serviceAccount"],
      secretShape: "secret_input",
      expectedResolvedValue: "string-or-object",
      accountIdPathSegmentIndex: 3,
    },
  ],
  channel: [
    {
      path: "serviceAccount",
      secretShape: "secret_input",
      expectedResolvedValue: "string-or-object",
    },
  ],
  collect(params) {
    collectConditionalChannelFieldAssignments({
      ...params,
      field: "serviceAccount",
      expected: "string-or-object",
      topLevelActiveWithoutAccounts: true,
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled && !hasOwnProperty(account, "serviceAccount"),
      accountActive: ({ enabled }) => enabled,
      topInactiveReason: "no enabled account inherits this top-level Google Chat serviceAccount.",
      accountInactiveReason: "Google Chat account is disabled.",
      owner: ({ accountId }) => ({
        ownerKind: "account",
        ownerId: `googlechat:${normalizeAccountId(accountId)}`,
        requiredForGateway: false,
        disposition: "isolate",
      }),
    });
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
