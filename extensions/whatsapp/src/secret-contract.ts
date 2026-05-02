import {
  collectSimpleChannelArrayFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

function secretInputTarget(pathPattern: string): SecretTargetRegistryEntry {
  const isAccountPath = pathPattern.startsWith("channels.whatsapp.accounts.");
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
  secretInputTarget("channels.whatsapp.allowFrom[]"),
  secretInputTarget("channels.whatsapp.defaultTo"),
  secretInputTarget("channels.whatsapp.groupAllowFrom[]"),
  secretInputTarget("channels.whatsapp.accounts.*.allowFrom[]"),
  secretInputTarget("channels.whatsapp.accounts.*.defaultTo"),
  secretInputTarget("channels.whatsapp.accounts.*.groupAllowFrom[]"),
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "whatsapp");
  if (!resolved) {
    return;
  }
  const { channel: whatsApp, surface } = resolved;
  for (const field of ["allowFrom", "groupAllowFrom"] as const) {
    collectSimpleChannelArrayFieldAssignments({
      channelKey: "whatsapp",
      field,
      channel: whatsApp,
      surface,
      defaults: params.defaults,
      context: params.context,
      topInactiveReason: `no enabled account inherits this top-level WhatsApp ${field}.`,
      accountInactiveReason: "WhatsApp account is disabled.",
    });
  }
  collectSimpleChannelFieldAssignments({
    channelKey: "whatsapp",
    field: "defaultTo",
    channel: whatsApp,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level WhatsApp defaultTo.",
    accountInactiveReason: "WhatsApp account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
