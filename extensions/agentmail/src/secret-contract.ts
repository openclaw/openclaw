import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "agentmail",
  account: ["apiKey", "webhookSecret"],
  channel: ["apiKey", "webhookSecret"],
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "agentmail");
  if (!resolved) {
    return;
  }
  for (const field of ["apiKey", "webhookSecret"] as const) {
    collectConditionalChannelFieldAssignments({
      channelKey: "agentmail",
      field,
      channel: resolved.channel,
      surface: resolved.surface,
      defaults: params.defaults,
      context: params.context,
      topLevelActiveWithoutAccounts: true,
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled && !hasOwnProperty(account, field),
      accountActive: ({ enabled }) => enabled,
      topInactiveReason: `no enabled AgentMail surface inherits this top-level ${field}.`,
      accountInactiveReason: "AgentMail account is disabled.",
    });
  }
}
