// Msteams plugin module implements secret contract behavior.
import {
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] = [
  {
    id: "channels.msteams.accounts.*.appPassword",
    targetType: "channels.msteams.accounts.*.appPassword",
    configFile: "openclaw.json",
    pathPattern: "channels.msteams.accounts.*.appPassword",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.msteams.appPassword",
    targetType: "channels.msteams.appPassword",
    configFile: "openclaw.json",
    pathPattern: "channels.msteams.appPassword",
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
  const resolved = getChannelSurface(params.config, "msteams");
  if (!resolved) {
    return;
  }
  const { channel: msteams, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    channelKey: "msteams",
    field: "appPassword",
    channel: msteams,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Microsoft Teams appPassword.",
    accountInactiveReason: "Microsoft Teams account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
