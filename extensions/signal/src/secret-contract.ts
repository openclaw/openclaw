import {
  collectSimpleChannelArrayFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

function secretInputTarget(pathPattern: string): SecretTargetRegistryEntry {
  const isAccountPath = pathPattern.startsWith("channels.signal.accounts.");
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
  secretInputTarget("channels.signal.account"),
  secretInputTarget("channels.signal.allowFrom[]"),
  secretInputTarget("channels.signal.defaultTo"),
  secretInputTarget("channels.signal.groupAllowFrom[]"),
  secretInputTarget("channels.signal.reactionAllowlist[]"),
  secretInputTarget("channels.signal.accounts.*.account"),
  secretInputTarget("channels.signal.accounts.*.allowFrom[]"),
  secretInputTarget("channels.signal.accounts.*.defaultTo"),
  secretInputTarget("channels.signal.accounts.*.groupAllowFrom[]"),
  secretInputTarget("channels.signal.accounts.*.reactionAllowlist[]"),
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "signal");
  if (!resolved) {
    return;
  }
  const { channel: signal, surface } = resolved;
  for (const field of ["account", "defaultTo"] as const) {
    collectSimpleChannelFieldAssignments({
      channelKey: "signal",
      field,
      channel: signal,
      surface,
      defaults: params.defaults,
      context: params.context,
      topInactiveReason: `no enabled account inherits this top-level Signal ${field}.`,
      accountInactiveReason: "Signal account is disabled.",
    });
  }
  for (const field of ["allowFrom", "groupAllowFrom", "reactionAllowlist"] as const) {
    collectSimpleChannelArrayFieldAssignments({
      channelKey: "signal",
      field,
      channel: signal,
      surface,
      defaults: params.defaults,
      context: params.context,
      topInactiveReason: `no enabled account inherits this top-level Signal ${field}.`,
      accountInactiveReason: "Signal account is disabled.",
    });
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
