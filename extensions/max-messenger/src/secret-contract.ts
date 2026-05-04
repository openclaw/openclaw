import {
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  hasOwnProperty,
  type ChannelAccountEntry,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries: readonly SecretTargetRegistryEntry[] = [
  {
    id: "channels.max-messenger.accounts.*.token",
    targetType: "channels.max-messenger.accounts.*.token",
    configFile: "openclaw.json",
    pathPattern: "channels.max-messenger.accounts.*.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.max-messenger.token",
    targetType: "channels.max-messenger.token",
    configFile: "openclaw.json",
    pathPattern: "channels.max-messenger.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "max-messenger");
  if (!resolved) {
    return;
  }
  const { channel: maxMessenger, surface } = resolved;
  const inheritsField =
    (field: string) =>
    ({ account, enabled }: ChannelAccountEntry) =>
      enabled && !hasOwnProperty(account, field);
  collectConditionalChannelFieldAssignments({
    channelKey: "max-messenger",
    field: "token",
    channel: maxMessenger,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: inheritsField("token"),
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled MAX Messenger surface inherits this top-level token.",
    accountInactiveReason: "MAX Messenger account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
