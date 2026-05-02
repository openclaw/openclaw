import {
  collectSimpleChannelArrayFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    id: "channels.bluebubbles.accounts.*.allowFrom[]",
    targetType: "channels.bluebubbles.accounts.*.allowFrom[]",
    configFile: "openclaw.json",
    pathPattern: "channels.bluebubbles.accounts.*.allowFrom[]",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    accountIdPathSegmentIndex: 3,
  },
  {
    id: "channels.bluebubbles.accounts.*.groupAllowFrom[]",
    targetType: "channels.bluebubbles.accounts.*.groupAllowFrom[]",
    configFile: "openclaw.json",
    pathPattern: "channels.bluebubbles.accounts.*.groupAllowFrom[]",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    accountIdPathSegmentIndex: 3,
  },
  {
    id: "channels.bluebubbles.accounts.*.password",
    targetType: "channels.bluebubbles.accounts.*.password",
    configFile: "openclaw.json",
    pathPattern: "channels.bluebubbles.accounts.*.password",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.bluebubbles.allowFrom[]",
    targetType: "channels.bluebubbles.allowFrom[]",
    configFile: "openclaw.json",
    pathPattern: "channels.bluebubbles.allowFrom[]",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.bluebubbles.groupAllowFrom[]",
    targetType: "channels.bluebubbles.groupAllowFrom[]",
    configFile: "openclaw.json",
    pathPattern: "channels.bluebubbles.groupAllowFrom[]",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.bluebubbles.password",
    targetType: "channels.bluebubbles.password",
    configFile: "openclaw.json",
    pathPattern: "channels.bluebubbles.password",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "bluebubbles");
  if (!resolved) {
    return;
  }
  const { channel: bluebubbles, surface } = resolved;
  for (const field of ["allowFrom", "groupAllowFrom"] as const) {
    collectSimpleChannelArrayFieldAssignments({
      channelKey: "bluebubbles",
      field,
      channel: bluebubbles,
      surface,
      defaults: params.defaults,
      context: params.context,
      topInactiveReason: `no enabled account inherits this top-level BlueBubbles ${field}.`,
      accountInactiveReason: "BlueBubbles account is disabled.",
    });
  }
  collectSimpleChannelFieldAssignments({
    channelKey: "bluebubbles",
    field: "password",
    channel: bluebubbles,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level BlueBubbles password.",
    accountInactiveReason: "BlueBubbles account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
