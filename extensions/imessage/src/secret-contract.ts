import {
  collectSimpleChannelArrayFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

function secretInputTarget(pathPattern: string): SecretTargetRegistryEntry {
  const isAccountPath = pathPattern.startsWith("channels.imessage.accounts.");
  return {
    id: pathPattern,
    targetType: pathPattern,
    configFile: "openclaw.json",
    pathPattern,
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    ...(isAccountPath ? { accountIdPathSegmentIndex: 3 } : {}),
  };
}

export const secretTargetRegistryEntries = [
  secretInputTarget("channels.imessage.allowFrom[]"),
  secretInputTarget("channels.imessage.defaultTo"),
  secretInputTarget("channels.imessage.groupAllowFrom[]"),
  secretInputTarget("channels.imessage.accounts.*.allowFrom[]"),
  secretInputTarget("channels.imessage.accounts.*.defaultTo"),
  secretInputTarget("channels.imessage.accounts.*.groupAllowFrom[]"),
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "imessage");
  if (!resolved) {
    return;
  }
  const { channel: iMessage, surface } = resolved;
  for (const field of ["allowFrom", "groupAllowFrom"] as const) {
    collectSimpleChannelArrayFieldAssignments({
      channelKey: "imessage",
      field,
      channel: iMessage,
      surface,
      defaults: params.defaults,
      context: params.context,
      topInactiveReason: `no enabled account inherits this top-level iMessage ${field}.`,
      accountInactiveReason: "iMessage account is disabled.",
    });
  }
  collectSimpleChannelFieldAssignments({
    channelKey: "imessage",
    field: "defaultTo",
    channel: iMessage,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level iMessage defaultTo.",
    accountInactiveReason: "iMessage account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
