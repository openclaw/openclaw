import {
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    id: "channels.vesicle.accounts.*.authToken",
    targetType: "channels.vesicle.accounts.*.authToken",
    configFile: "openclaw.json",
    pathPattern: "channels.vesicle.accounts.*.authToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.vesicle.authToken",
    targetType: "channels.vesicle.authToken",
    configFile: "openclaw.json",
    pathPattern: "channels.vesicle.authToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.vesicle.accounts.*.webhookSecret",
    targetType: "channels.vesicle.accounts.*.webhookSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.vesicle.accounts.*.webhookSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.vesicle.webhookSecret",
    targetType: "channels.vesicle.webhookSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.vesicle.webhookSecret",
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
  const resolved = getChannelSurface(params.config, "vesicle");
  if (!resolved) {
    return;
  }
  const { channel: vesicle, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    channelKey: "vesicle",
    field: "authToken",
    channel: vesicle,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Vesicle authToken.",
    accountInactiveReason: "Vesicle account is disabled.",
  });
  collectSimpleChannelFieldAssignments({
    channelKey: "vesicle",
    field: "webhookSecret",
    channel: vesicle,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Vesicle webhookSecret.",
    accountInactiveReason: "Vesicle account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
